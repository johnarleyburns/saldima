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

  it("voids a transaction, zeroing its effect on balances without deleting it, then unvoids it", async () => {
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
          { accountGuid: BANK, value: money(-500n, 100n), memo: "beans" },
          { accountGuid: SALARY, value: money(500n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );
    doc.setSplitReconcileState(txId, splitIds[0] ?? "", "c");

    doc.voidTransaction(txId, "Entered in error", "2026-02-10 00:00:00 +0000");
    const voided = doc.transaction(txId);
    expect(voided).toMatchObject({
      voided: true,
      voidReason: "Entered in error",
      voidTime: "2026-02-10 00:00:00 +0000",
    });
    // Zeroed, so it no longer affects any balance -- but the original
    // amounts and the memo survive for audit, and the split is flagged "v".
    expect(voided?.splits[0]).toMatchObject({
      memo: "beans",
      reconcileState: "v",
      value: money(0n, 100n),
      quantity: money(0n, 100n),
      voidFormerValue: money(-500n, 100n),
      voidFormerQuantity: money(-500n, 100n),
    });

    const reparsed = GncXmlDocument.parse(doc.serialize());
    const reparsedVoided = reparsed.transaction(txId);
    expect(reparsedVoided?.voided).toBe(true);
    expect(reparsedVoided?.splits[0]?.value).toEqual(money(0n, 100n));

    doc.unvoidTransaction(txId);
    const unvoided = doc.transaction(txId);
    expect(unvoided).toMatchObject({ voided: false, voidReason: null, voidTime: null });
    expect(unvoided?.splits[0]).toMatchObject({
      reconcileState: "n",
      value: money(-500n, 100n),
      quantity: money(-500n, 100n),
      voidFormerValue: null,
      voidFormerQuantity: null,
    });
  });

  it("refuses to void an already-voided transaction, to void or unvoid an unknown one, or to void with a blank reason", async () => {
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

    expect(() => doc.voidTransaction(txId, "  ", "2026-02-10 00:00:00 +0000")).toThrow(
      GncXmlError,
    );
    expect(() =>
      doc.voidTransaction(guidFrom("f".repeat(32)), "x", "2026-02-10 00:00:00 +0000"),
    ).toThrow(GncXmlError);
    expect(() => doc.unvoidTransaction(txId)).toThrow(GncXmlError);

    doc.voidTransaction(txId, "Entered in error", "2026-02-10 00:00:00 +0000");
    expect(() =>
      doc.voidTransaction(txId, "Again", "2026-02-11 00:00:00 +0000"),
    ).toThrow(GncXmlError);
    expect(() => doc.unvoidTransaction(guidFrom("f".repeat(32)))).toThrow(GncXmlError);
  });

  it("does not invent a notes slot when voiding/unvoiding a transaction that never had one", async () => {
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
    doc.voidTransaction(txId, "Entered in error", "2026-02-10 00:00:00 +0000");
    expect(doc.serialize()).toContain('<slot:value type="string">Voided transaction');
    doc.unvoidTransaction(txId);
    expect(doc.serialize()).not.toContain("void-former-notes");
  });

  it("moves a pre-existing notes value to void-former-notes, then restores it on unvoid", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book" xmlns:trn="http://www.gnucash.org/XML/trn" xmlns:split="http://www.gnucash.org/XML/split" xmlns:slot="http://www.gnucash.org/XML/slot" xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:book version="2.0.0">
<book:id type="guid">${"d".repeat(32)}</book:id>
<gnc:transaction version="2.0.0">
  <trn:id type="guid">${"e".repeat(32)}</trn:id>
  <trn:description>Imported from desktop</trn:description>
  <trn:slots>
    <slot>
      <slot:key>notes</slot:key>
      <slot:value type="string">Called the vendor about this one</slot:value>
    </slot>
  </trn:slots>
  <trn:splits>
    <trn:split>
      <split:id type="guid">${"f0".repeat(16)}</split:id>
      <split:value>-500/100</split:value>
      <split:account type="guid">${"f1".repeat(16)}</split:account>
    </trn:split>
    <trn:split>
      <split:id type="guid">${"f2".repeat(16)}</split:id>
      <split:value>500/100</split:value>
      <split:account type="guid">${"f3".repeat(16)}</split:account>
    </trn:split>
  </trn:splits>
</gnc:transaction>
</gnc:book>
</gnc-v2>`);
    const txId = "e".repeat(32);

    doc.voidTransaction(txId, "Entered in error", "2026-02-10 00:00:00 +0000");
    const serializedVoided = doc.serialize();
    expect(serializedVoided).toContain(
      '<slot:value type="string">Called the vendor about this one</slot:value>',
    );
    expect(serializedVoided).toContain('<slot:value type="string">Voided transaction');

    doc.unvoidTransaction(txId);
    const serializedUnvoided = doc.serialize();
    expect(serializedUnvoided).not.toContain("void-former-notes");
    expect(serializedUnvoided).toContain(
      '<slot:value type="string">Called the vendor about this one</slot:value>',
    );
  });

  describe("scheduled transactions", () => {
    function createMonthlySalary(doc: GncXmlDocument, sxGuid: string) {
      return doc.createScheduledTransaction(
        {
          name: "Monthly salary",
          description: "Salary",
          currency: USD,
          autoCreate: true,
          advanceCreateDays: 2,
          advanceRemindDays: 5,
          start: "2026-01-15",
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(50000n, 100n) },
            { accountGuid: SALARY, value: money(-50000n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom(sxGuid),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
    }

    it("creates a scheduled transaction matching real GnuCash's on-disk shape, and reads it back", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = createMonthlySalary(doc, "1".repeat(32));

      expect(sx).toMatchObject({
        name: "Monthly salary",
        description: "Salary",
        enabled: true,
        autoCreate: true,
        autoCreateNotify: false,
        advanceCreateDays: 2,
        advanceRemindDays: 5,
        start: "2026-01-15",
        lastOccurred: null,
        instanceCount: 0,
        end: null,
        recurrence: {
          periodType: "month",
          multiplier: 1,
          start: "2026-01-15",
          weekendAdjust: "none",
        },
      });
      expect(sx.templateSplits).toEqual([
        { accountGuid: BANK, value: money(50000n, 100n) },
        { accountGuid: SALARY, value: money(-50000n, 100n) },
      ]);

      const serialized = doc.serialize();
      expect(serialized).toContain("<gnc:template-transactions>");
      expect(serialized).toContain("<act:name>Template Root</act:name>");
      expect(serialized).toContain("<act:type>ROOT</act:type>");
      expect(serialized).toContain("<cmdty:space>template</cmdty:space>");
      expect(serialized).toContain(
        "<recurrence:period_type>month</recurrence:period_type>",
      );
      expect(serialized).toContain("<slot:key>sched-xaction</slot:key>");
      expect(serialized).toContain("<slot:key>debit-formula</slot:key>");
      // The unused side of each split's KVP is an empty formula and a zero
      // numeric, not omitted -- matching real GnuCash exactly.
      expect(serialized).toContain(
        '<slot:key>credit-formula</slot:key><slot:value type="string"/>',
      );
      expect(serialized).toContain(
        '<slot:key>credit-numeric</slot:key><slot:value type="numeric">0/1</slot:value>',
      );

      // Not a normal account/transaction: stays out of the everyday lists.
      expect(doc.accounts().some((a) => a.guid === sx.templateAccountGuid)).toBe(false);
      expect(doc.transactions()).toHaveLength(1); // only the fixture's own pre-existing one

      const reparsed = GncXmlDocument.parse(serialized);
      expect(reparsed.scheduledTransaction(sx.guid)).toEqual(sx);
    });

    it("shares one Template Root across multiple scheduled transactions", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      createMonthlySalary(doc, "1".repeat(32));
      const second = doc.createScheduledTransaction(
        {
          name: "Rent",
          description: "Rent",
          currency: USD,
          start: "2026-02-01",
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-02-01",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: SALARY, value: money(120000n, 100n) },
            { accountGuid: BANK, value: money(-120000n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("2".repeat(32)),
          templateAccount: guidFrom("3".repeat(32)),
          templateTransaction: guidFrom("4".repeat(32)),
          templateSplits: [guidFrom("a0".repeat(16)), guidFrom("a1".repeat(16))],
          // No templateRoot id -- must reuse the one the first SX created.
        },
      );
      expect(doc.scheduledTransactions()).toHaveLength(2);
      expect((doc.serialize().match(/<act:type>ROOT<\/act:type>/g) ?? []).length).toBe(
        2,
      ); // the fixture's book root + one shared template root
      expect(second.enabled).toBe(true);
      expect(second.autoCreate).toBe(false);
    });

    it("refuses to create the first scheduled transaction without a template-root id, an unbalanced template, too few splits, or a duplicate guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      expect(() =>
        doc.createScheduledTransaction(
          {
            name: "x",
            description: "x",
            currency: USD,
            start: "2026-01-01",
            recurrence: {
              periodType: "month",
              multiplier: 1,
              start: "2026-01-01",
              weekendAdjust: "none",
            },
            templateSplits: [
              { accountGuid: BANK, value: money(100n, 100n) },
              { accountGuid: SALARY, value: money(-100n, 100n) },
            ],
          },
          {
            scheduledTransaction: guidFrom("1".repeat(32)),
            templateAccount: guidFrom("d".repeat(32)),
            templateTransaction: guidFrom("e".repeat(32)),
            templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          },
        ),
      ).toThrow(GncXmlError);

      expect(() =>
        doc.createScheduledTransaction(
          {
            name: "x",
            description: "x",
            currency: USD,
            start: "2026-01-01",
            recurrence: {
              periodType: "month",
              multiplier: 1,
              start: "2026-01-01",
              weekendAdjust: "none",
            },
            templateSplits: [{ accountGuid: BANK, value: money(100n, 100n) }],
          },
          {
            scheduledTransaction: guidFrom("1".repeat(32)),
            templateAccount: guidFrom("d".repeat(32)),
            templateTransaction: guidFrom("e".repeat(32)),
            templateSplits: [guidFrom("f0".repeat(16))],
            templateRoot: guidFrom("f2".repeat(16)),
          },
        ),
      ).toThrow(GncXmlError);

      expect(() =>
        doc.createScheduledTransaction(
          {
            name: "x",
            description: "x",
            currency: USD,
            start: "2026-01-01",
            recurrence: {
              periodType: "month",
              multiplier: 1,
              start: "2026-01-01",
              weekendAdjust: "none",
            },
            templateSplits: [
              { accountGuid: BANK, value: money(100n, 100n) },
              { accountGuid: SALARY, value: money(-99n, 100n) },
            ],
          },
          {
            scheduledTransaction: guidFrom("1".repeat(32)),
            templateAccount: guidFrom("d".repeat(32)),
            templateTransaction: guidFrom("e".repeat(32)),
            templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
            templateRoot: guidFrom("f2".repeat(16)),
          },
        ),
      ).toThrow(GncXmlError);

      createMonthlySalary(doc, "1".repeat(32));
      expect(() => createMonthlySalary(doc, "1".repeat(32))).toThrow(GncXmlError);
    });

    it("updates the simple fields of a scheduled transaction, and rejects an unknown guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = createMonthlySalary(doc, "1".repeat(32));
      const updated = doc.updateScheduledTransaction(sx.guid, {
        name: "Renamed",
        enabled: false,
        autoCreate: false,
        autoCreateNotify: true,
        advanceCreateDays: 10,
        advanceRemindDays: 20,
      });
      expect(updated).toMatchObject({
        name: "Renamed",
        enabled: false,
        autoCreate: false,
        autoCreateNotify: true,
        advanceCreateDays: 10,
        advanceRemindDays: 20,
      });
      expect(() =>
        doc.updateScheduledTransaction(guidFrom("f".repeat(32)), { name: "x" }),
      ).toThrow(GncXmlError);

      // A partial update leaves every other field untouched.
      const partial = doc.updateScheduledTransaction(sx.guid, {
        name: "Renamed again",
      });
      expect(partial).toMatchObject({
        name: "Renamed again",
        enabled: false,
        autoCreate: false,
        autoCreateNotify: true,
        advanceCreateDays: 10,
        advanceRemindDays: 20,
      });
    });

    it("round-trips a weekend-adjusted recurrence", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = doc.createScheduledTransaction(
        {
          name: "Weekend adjusted",
          description: "Weekend adjusted",
          currency: USD,
          start: "2026-01-15",
          recurrence: {
            periodType: "week",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "forward",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(100n, 100n) },
            { accountGuid: SALARY, value: money(-100n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("1".repeat(32)),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
      expect(sx.recurrence.weekendAdjust).toBe("forward");
      const reparsed = GncXmlDocument.parse(doc.serialize());
      expect(reparsed.scheduledTransaction(sx.guid)?.recurrence.weekendAdjust).toBe(
        "forward",
      );
    });

    it("can be created disabled, with autoCreateNotify on, and in a currency with no commodity entry yet", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = doc.createScheduledTransaction(
        {
          name: "Disabled, notify-on-create, unknown currency",
          description: "x",
          currency: { space: "CURRENCY", id: "GBP" },
          enabled: false,
          autoCreate: true,
          autoCreateNotify: true,
          start: "2026-01-15",
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(100n, 100n) },
            { accountGuid: SALARY, value: money(-100n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("1".repeat(32)),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
      expect(sx).toMatchObject({
        enabled: false,
        autoCreate: true,
        autoCreateNotify: true,
      });
      // A currency with no existing commodity entry falls back to the
      // conventional 100 (cents) fraction for the zero placeholder value.
      expect(doc.serialize()).toContain("<split:value>0/100</split:value>");
    });

    it("uses an existing commodity's own fraction for the zero placeholder value", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      doc.ensureCommodity({ space: "CURRENCY", id: "EUR" }, 100);
      doc.createScheduledTransaction(
        {
          name: "Euro schedule",
          description: "x",
          currency: { space: "CURRENCY", id: "EUR" },
          start: "2026-01-15",
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(100n, 100n) },
            { accountGuid: SALARY, value: money(-100n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("1".repeat(32)),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
      expect(doc.serialize()).toContain("<split:value>0/100</split:value>");
    });

    it("defaults missing schedule/template data when reading a hand-written scheduled transaction", () => {
      const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book" xmlns:sx="http://www.gnucash.org/XML/sx">
<gnc:book version="2.0.0">
<book:id type="guid">${"9".repeat(32)}</book:id>
<gnc:schedxaction version="2.0.0">
  <sx:id type="guid">${"1".repeat(32)}</sx:id>
  <sx:name>Minimal</sx:name>
  <sx:advanceCreateDays>0</sx:advanceCreateDays>
  <sx:advanceRemindDays>0</sx:advanceRemindDays>
  <sx:instanceCount>0</sx:instanceCount>
  <sx:start><gdate>2026-01-01</gdate></sx:start>
  <sx:templ-acct type="guid">${"f".repeat(32)}</sx:templ-acct>
</gnc:schedxaction>
</gnc:book>
</gnc-v2>`);
      const sx = doc.scheduledTransaction("1".repeat(32));
      expect(sx).toMatchObject({
        name: "Minimal",
        description: "",
        currency: { space: "CURRENCY", id: "USD" },
        enabled: true,
        autoCreate: false,
        autoCreateNotify: false,
        recurrence: {
          periodType: "once",
          multiplier: 1,
          start: "2026-01-01",
          weekendAdjust: "none",
        },
        templateSplits: [],
      });
    });

    it("posts a due instance, advancing sx:last and instanceCount, and rejects an unknown guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = createMonthlySalary(doc, "1".repeat(32));

      const posted = doc.postScheduledInstance(sx.guid, "2026-01-15", {
        transaction: guidFrom("9".repeat(32)),
        splits: [guidFrom("b0".repeat(16)), guidFrom("b1".repeat(16))],
      });
      expect(posted.description).toBe("Salary");
      expect(posted.splits.map((s) => [s.accountGuid, s.value])).toEqual([
        [BANK, money(50000n, 100n)],
        [SALARY, money(-50000n, 100n)],
      ]);

      const advanced = doc.scheduledTransaction(sx.guid);
      expect(advanced?.lastOccurred).toBe("2026-01-15");
      expect(advanced?.instanceCount).toBe(1);

      // Posting again updates sx:last in place rather than duplicating it.
      doc.postScheduledInstance(sx.guid, "2026-02-15", {
        transaction: guidFrom("a".repeat(32)),
        splits: [guidFrom("d0".repeat(16)), guidFrom("d1".repeat(16))],
      });
      const advancedAgain = doc.scheduledTransaction(sx.guid);
      expect(advancedAgain?.lastOccurred).toBe("2026-02-15");
      expect(advancedAgain?.instanceCount).toBe(2);

      expect(() =>
        doc.postScheduledInstance(guidFrom("f".repeat(32)), "2026-02-15", {
          transaction: guidFrom("8".repeat(32)),
          splits: [guidFrom("c0".repeat(16)), guidFrom("c1".repeat(16))],
        }),
      ).toThrow(GncXmlError);
    });

    it("skips a due instance without posting anything, and rejects an unknown guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = createMonthlySalary(doc, "1".repeat(32));
      const transactionsBefore = doc.transactions().length;

      doc.skipScheduledInstance(sx.guid, "2026-01-15");
      expect(doc.transactions()).toHaveLength(transactionsBefore);
      const advanced = doc.scheduledTransaction(sx.guid);
      expect(advanced?.lastOccurred).toBe("2026-01-15");
      expect(advanced?.instanceCount).toBe(1);

      expect(() =>
        doc.skipScheduledInstance(guidFrom("f".repeat(32)), "2026-01-15"),
      ).toThrow(GncXmlError);
    });

    it("deletes a scheduled transaction along with its template account and transaction", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = createMonthlySalary(doc, "1".repeat(32));
      doc.deleteScheduledTransaction(sx.guid);
      expect(doc.scheduledTransaction(sx.guid)).toBeUndefined();
      expect(doc.serialize()).not.toContain(sx.templateAccountGuid);
      // Deleting an unknown scheduled transaction is a no-op.
      doc.deleteScheduledTransaction(guidFrom("f".repeat(32)));
    });

    it("classifies due instances by auto-create/notify and respects the reminder window", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      createMonthlySalary(doc, "1".repeat(32)); // autoCreate: true, autoCreateNotify: false

      // 2026-01-15 + advanceCreateDays(2) = 2026-01-17: due to auto-post as of 2026-01-16.
      expect(doc.dueScheduledInstances("2026-01-16")).toEqual([
        {
          scheduledTransactionGuid: guidFrom("1".repeat(32)),
          name: "Monthly salary",
          date: "2026-01-15",
          action: "autoPost",
        },
      ]);

      // Long before the start date and outside the remind window: nothing due.
      expect(doc.dueScheduledInstances("2025-11-01")).toEqual([]);

      // Within the remind window (5 days past the create boundary) but not yet due to create.
      const remindOnly = doc.dueScheduledInstances("2026-01-09");
      expect(remindOnly).toEqual([
        {
          scheduledTransactionGuid: guidFrom("1".repeat(32)),
          name: "Monthly salary",
          date: "2026-01-15",
          action: "reminder",
        },
      ]);

      // A disabled schedule never shows up.
      doc.updateScheduledTransaction(guidFrom("1".repeat(32)), { enabled: false });
      expect(doc.dueScheduledInstances("2026-01-16")).toEqual([]);
    });

    it("needsApproval when autoCreate is off, and autoPostNotify when both flags are on", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const sx = doc.createScheduledTransaction(
        {
          name: "Manual review",
          description: "Manual review",
          currency: USD,
          start: "2026-01-15",
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(100n, 100n) },
            { accountGuid: SALARY, value: money(-100n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("1".repeat(32)),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
      expect(doc.dueScheduledInstances("2026-01-15")[0]?.action).toBe("needsApproval");

      doc.updateScheduledTransaction(sx.guid, {
        autoCreate: true,
        autoCreateNotify: true,
      });
      expect(doc.dueScheduledInstances("2026-01-15")[0]?.action).toBe("autoPostNotify");
    });

    it("stops generating instances once an occurrence-count end condition is reached", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      doc.createScheduledTransaction(
        {
          name: "Two payments only",
          description: "Two payments only",
          currency: USD,
          autoCreate: true,
          start: "2026-01-15",
          end: { occurrences: 1 },
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(100n, 100n) },
            { accountGuid: SALARY, value: money(-100n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("1".repeat(32)),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
      expect(doc.dueScheduledInstances("2026-01-16")).toHaveLength(1);
      doc.postScheduledInstance(guidFrom("1".repeat(32)), "2026-01-15", {
        transaction: guidFrom("9".repeat(32)),
        splits: [guidFrom("b0".repeat(16)), guidFrom("b1".repeat(16))],
      });
      // The one allowed occurrence has posted -- the schedule is exhausted.
      expect(doc.dueScheduledInstances("2026-06-01")).toEqual([]);
    });

    it("stops generating instances once a date-based end condition is passed", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      doc.createScheduledTransaction(
        {
          name: "Ends in February",
          description: "Ends in February",
          currency: USD,
          autoCreate: true,
          start: "2026-01-15",
          end: { date: "2026-02-01" },
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-15",
            weekendAdjust: "none",
          },
          templateSplits: [
            { accountGuid: BANK, value: money(100n, 100n) },
            { accountGuid: SALARY, value: money(-100n, 100n) },
          ],
        },
        {
          scheduledTransaction: guidFrom("1".repeat(32)),
          templateAccount: guidFrom("d".repeat(32)),
          templateTransaction: guidFrom("e".repeat(32)),
          templateSplits: [guidFrom("f0".repeat(16)), guidFrom("f1".repeat(16))],
          templateRoot: guidFrom("f2".repeat(16)),
        },
      );
      // The January instance is within the end date.
      expect(doc.dueScheduledInstances("2026-01-16")).toHaveLength(1);
      doc.postScheduledInstance(guidFrom("1".repeat(32)), "2026-01-15", {
        transaction: guidFrom("9".repeat(32)),
        splits: [guidFrom("b0".repeat(16)), guidFrom("b1".repeat(16))],
      });
      // The only remaining candidate, 2026-02-15, is past the 2026-02-01 end date.
      expect(doc.dueScheduledInstances("2026-03-01")).toEqual([]);
    });
  });

  describe("budgets", () => {
    function createMonthlyBudget(doc: GncXmlDocument, guid: string) {
      return doc.createBudget(
        {
          name: "2026 household",
          description: "Household budget for 2026",
          periodCount: 12,
          recurrence: {
            periodType: "month",
            multiplier: 1,
            start: "2026-01-01",
            weekendAdjust: "none",
          },
        },
        guidFrom(guid),
      );
    }

    it("creates a budget matching real GnuCash's on-disk shape, and reads it back", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));

      expect(budget).toEqual({
        guid: "1".repeat(32),
        name: "2026 household",
        description: "Household budget for 2026",
        periodCount: 12,
        recurrence: {
          periodType: "month",
          multiplier: 1,
          start: "2026-01-01",
          weekendAdjust: "none",
        },
      });

      const serialized = doc.serialize();
      expect(serialized).toContain('<gnc:budget version="2.0.0">');
      expect(serialized).toContain(`<bgt:id type="guid">${"1".repeat(32)}</bgt:id>`);
      expect(serialized).toContain("<bgt:name>2026 household</bgt:name>");
      expect(serialized).toContain("<bgt:num-periods>12</bgt:num-periods>");
      // No separate wrapper -- the version attribute and recurrence:* children
      // sit directly on <bgt:recurrence>, unlike sx:schedule's inner gnc:recurrence.
      expect(serialized).toContain('<bgt:recurrence version="1.0.0">');
      expect(serialized).toContain(
        "<recurrence:period_type>month</recurrence:period_type>",
      );
      expect(serialized).not.toContain("<gnc:recurrence");

      const reparsed = GncXmlDocument.parse(serialized);
      expect(reparsed.budget(budget.guid)).toEqual(budget);
    });

    it("supports multiple budgets per book", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      createMonthlyBudget(doc, "1".repeat(32));
      doc.createBudget(
        {
          name: "Vacation fund",
          periodCount: 4,
          recurrence: {
            periodType: "end_of_month",
            multiplier: 3,
            start: "2026-01-01",
            weekendAdjust: "none",
          },
        },
        guidFrom("2".repeat(32)),
      );
      expect(
        doc
          .budgets()
          .map((b) => b.name)
          .sort(),
      ).toEqual(["2026 household", "Vacation fund"]);
    });

    it("rejects a budget with fewer than one period", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      expect(() =>
        doc.createBudget(
          {
            name: "Bad",
            periodCount: 0,
            recurrence: {
              periodType: "month",
              multiplier: 1,
              start: "2026-01-01",
              weekendAdjust: "none",
            },
          },
          guidFrom("1".repeat(32)),
        ),
      ).toThrow(GncXmlError);
    });

    it("rejects a duplicate budget guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      createMonthlyBudget(doc, "1".repeat(32));
      expect(() => createMonthlyBudget(doc, "1".repeat(32))).toThrow(GncXmlError);
    });

    it("updates name, description and periodCount independently", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      const updated = doc.updateBudget(budget.guid, { name: "Renamed" });
      expect(updated.name).toBe("Renamed");
      expect(updated.description).toBe(budget.description);
      expect(updated.periodCount).toBe(budget.periodCount);

      const updated2 = doc.updateBudget(budget.guid, { periodCount: 6 });
      expect(updated2.periodCount).toBe(6);
      expect(updated2.name).toBe("Renamed");

      const updated3 = doc.updateBudget(budget.guid, {
        description: "New description",
      });
      expect(updated3.description).toBe("New description");
      expect(updated3.name).toBe("Renamed");
    });

    it("rejects updating to fewer than one period, and updating an unknown budget", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      expect(() => doc.updateBudget(budget.guid, { periodCount: 0 })).toThrow(
        GncXmlError,
      );
      expect(() => doc.updateBudget("f".repeat(32), { name: "x" })).toThrow(
        GncXmlError,
      );
    });

    it("deletes a budget", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      doc.deleteBudget(budget.guid);
      expect(doc.budgets()).toEqual([]);
      // Deleting an unknown budget is a silent no-op, matching deleteAccount/deleteTransaction.
      expect(() => doc.deleteBudget("f".repeat(32))).not.toThrow();
    });

    it("computes each period's [start, end) range from the recurrence", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      expect(doc.periodRange(budget, 0)).toEqual({
        start: "2026-01-01",
        end: "2026-02-01",
      });
      expect(doc.periodRange(budget, 1)).toEqual({
        start: "2026-02-01",
        end: "2026-03-01",
      });
      expect(doc.periodRange(budget, 11)).toEqual({
        start: "2026-12-01",
        end: "2027-01-01",
      });
      expect(() => doc.periodRange(budget, -1)).toThrow(GncXmlError);
    });

    it("throws computing a period's end past a 'once' recurrence's single instance", async () => {
      // A "once" recurrence has no second instance, so it has no valid
      // upper bound for any period -- not a realistic budget recurrence in
      // practice (desktop GnuCash's own budget editor only offers repeating
      // period types), but the engine should fail loudly rather than
      // silently miscomputing a range.
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = doc.createBudget(
        {
          name: "One-off",
          periodCount: 1,
          recurrence: {
            periodType: "once",
            multiplier: 1,
            start: "2026-01-01",
            weekendAdjust: "none",
          },
        },
        guidFrom("5".repeat(32)),
      );
      expect(() => doc.periodRange(budget, 0)).toThrow(GncXmlError);
    });

    it("sets, reads back and removes a per-account-per-period amount, never writing a zero placeholder", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));

      expect(doc.budgetAmount(budget.guid, BANK, 0)).toBeNull();

      doc.setBudgetAmount(budget.guid, BANK, 0, money(150000n, 100n));
      expect(doc.budgetAmount(budget.guid, BANK, 0)).toEqual(money(150000n, 100n));

      const serialized = doc.serialize();
      expect(serialized).toContain(`<slot:key>${BANK}</slot:key>`);
      expect(serialized).toContain('<slot:value type="frame">');
      expect(serialized).toContain("<slot:key>0</slot:key>");
      expect(serialized).toContain(
        '<slot:key>0</slot:key><slot:value type="numeric">150000/100</slot:value>',
      );

      const reparsed = GncXmlDocument.parse(serialized);
      expect(reparsed.budgetAmount(budget.guid, BANK, 0)).toEqual(money(150000n, 100n));

      doc.setBudgetAmount(budget.guid, BANK, 0, null);
      expect(doc.budgetAmount(budget.guid, BANK, 0)).toBeNull();
      // Removing the only set period removes the now-empty account frame too.
      expect(doc.serialize()).not.toContain(`<slot:key>${BANK}</slot:key>`);
    });

    it("tracks several accounts and periods independently on the same budget", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      doc.setBudgetAmount(budget.guid, BANK, 0, money(100000n, 100n));
      doc.setBudgetAmount(budget.guid, BANK, 1, money(110000n, 100n));
      doc.setBudgetAmount(budget.guid, SALARY, 0, money(-250000n, 100n));

      expect(doc.budgetAmount(budget.guid, BANK, 0)).toEqual(money(100000n, 100n));
      expect(doc.budgetAmount(budget.guid, BANK, 1)).toEqual(money(110000n, 100n));
      expect(doc.budgetAmount(budget.guid, BANK, 2)).toBeNull();
      expect(doc.budgetAmount(budget.guid, SALARY, 0)).toEqual(money(-250000n, 100n));

      // Overwriting an already-set period updates it in place.
      doc.setBudgetAmount(budget.guid, BANK, 1, money(120000n, 100n));
      expect(doc.budgetAmount(budget.guid, BANK, 1)).toEqual(money(120000n, 100n));

      // Removing a period that was never set, on an account that still has
      // a frame (because another period on it is set), is also a no-op.
      doc.setBudgetAmount(budget.guid, BANK, 5, null);
      expect(doc.budgetAmount(budget.guid, BANK, 5)).toBeNull();
      expect(doc.budgetAmount(budget.guid, BANK, 1)).toEqual(money(120000n, 100n));

      // Removing one period leaves the account's other set period untouched.
      doc.setBudgetAmount(budget.guid, BANK, 0, null);
      expect(doc.budgetAmount(budget.guid, BANK, 0)).toBeNull();
      expect(doc.budgetAmount(budget.guid, BANK, 1)).toEqual(money(120000n, 100n));
    });

    it("removing an amount from an unknown budget or an account with no frame is a silent no-op", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      expect(() => doc.setBudgetAmount(budget.guid, BANK, 0, null)).not.toThrow();
      expect(doc.budgetAmount("f".repeat(32), BANK, 0)).toBeNull();
    });

    it("rejects setting an amount on an unknown budget or a negative period index", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));
      expect(() => doc.setBudgetAmount("f".repeat(32), BANK, 0, money(1n, 1n))).toThrow(
        GncXmlError,
      );
      expect(() => doc.setBudgetAmount(budget.guid, BANK, -1, money(1n, 1n))).toThrow(
        GncXmlError,
      );
    });

    it("computes actual as the sum of an account's splits inside the period, live, never stored", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const budget = createMonthlyBudget(doc, "1".repeat(32));

      doc.postTransaction(
        {
          currency: USD,
          datePosted: "2026-01-15 10:00:00 +0000",
          dateEntered: "2026-01-15 10:00:00 +0000",
          description: "January paycheck",
          splits: [
            { accountGuid: BANK, value: money(300000n, 100n) },
            { accountGuid: SALARY, value: money(-300000n, 100n) },
          ],
        },
        {
          transaction: guidFrom("9".repeat(32)),
          splits: [guidFrom("a0".repeat(16)), guidFrom("a1".repeat(16))],
        },
      );
      // Outside period 0's range -- must not be counted.
      doc.postTransaction(
        {
          currency: USD,
          datePosted: "2026-02-15 10:00:00 +0000",
          dateEntered: "2026-02-15 10:00:00 +0000",
          description: "February paycheck",
          splits: [
            { accountGuid: BANK, value: money(300000n, 100n) },
            { accountGuid: SALARY, value: money(-300000n, 100n) },
          ],
        },
        {
          transaction: guidFrom("a".repeat(32)),
          splits: [guidFrom("b0".repeat(16)), guidFrom("b1".repeat(16))],
        },
      );

      // addMoney reduces to lowest terms, so 300000/100 comes back as 3000/1.
      expect(doc.budgetActual(budget.guid, BANK, 0)).toEqual(money(3000n, 1n));
      expect(doc.budgetActual(budget.guid, SALARY, 0)).toEqual(money(-3000n, 1n));
      expect(doc.budgetActual(budget.guid, BANK, 1)).toEqual(money(3000n, 1n));
      // Never written to disk.
      expect(doc.serialize()).not.toContain("budget-actual");
    });

    it("throws computing actual for an unknown budget", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      expect(() => doc.budgetActual("f".repeat(32), BANK, 0)).toThrow(GncXmlError);
    });

    it("round-trips a hand-written budget fixture with pre-existing amounts untouched", () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:bgt="http://www.gnucash.org/XML/bgt" xmlns:book="http://www.gnucash.org/XML/book" xmlns:recurrence="http://www.gnucash.org/XML/recurrence" xmlns:slot="http://www.gnucash.org/XML/slot">
<gnc:book version="2.0.0">
<book:id type="guid">${"b".repeat(32)}</book:id>
<gnc:budget version="2.0.0">
  <bgt:id type="guid">${"7".repeat(32)}</bgt:id>
  <bgt:name>Hand-written</bgt:name>
  <bgt:description>A fixture written by hand, not this engine</bgt:description>
  <bgt:num-periods>3</bgt:num-periods>
  <bgt:recurrence version="1.0.0">
    <recurrence:mult>1</recurrence:mult>
    <recurrence:period_type>month</recurrence:period_type>
    <recurrence:start><gdate>2026-06-01</gdate></recurrence:start>
  </bgt:recurrence>
  <bgt:slots>
    <slot>
      <slot:key>${BANK}</slot:key>
      <slot:value type="frame">
        <slot><slot:key>0</slot:key><slot:value type="numeric">50000/100</slot:value></slot>
        <slot><slot:key>2</slot:key><slot:value type="numeric">60000/100</slot:value></slot>
      </slot:value>
    </slot>
  </bgt:slots>
</gnc:budget>
</gnc:book>
</gnc-v2>`;
      const doc = GncXmlDocument.parse(xml);
      expect(doc.budget("7".repeat(32))).toEqual({
        guid: "7".repeat(32),
        name: "Hand-written",
        description: "A fixture written by hand, not this engine",
        periodCount: 3,
        recurrence: {
          periodType: "month",
          multiplier: 1,
          start: "2026-06-01",
          weekendAdjust: "none",
        },
      });
      expect(doc.budgetAmount("7".repeat(32), BANK, 0)).toEqual(money(50000n, 100n));
      expect(doc.budgetAmount("7".repeat(32), BANK, 1)).toBeNull();
      expect(doc.budgetAmount("7".repeat(32), BANK, 2)).toEqual(money(60000n, 100n));

      const serialized = doc.serialize();
      const reparsed = GncXmlDocument.parse(serialized);
      expect(reparsed.budget("7".repeat(32))).toEqual(doc.budget("7".repeat(32)));
      expect(reparsed.budgetAmount("7".repeat(32), BANK, 0)).toEqual(
        money(50000n, 100n),
      );
    });
  });

  describe("prices", () => {
    const EUR = { space: "CURRENCY", id: "EUR" };
    const AAPL = { space: "NASDAQ", id: "AAPL" };

    it("creates a price matching real GnuCash's on-disk shape, and reads it back", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const price = doc.createPrice(
        {
          commodity: EUR,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(108n, 100n),
        },
        guidFrom("1".repeat(32)),
      );

      expect(price).toEqual({
        guid: "1".repeat(32),
        commodity: EUR,
        currency: USD,
        time: "2026-01-15 00:00:00 +0000",
        source: "user:price-editor",
        type: "",
        value: money(108n, 100n),
      });

      const serialized = doc.serialize();
      expect(serialized).toContain('<gnc:pricedb version="1">');
      expect(serialized).toContain(
        `<price:id type="guid">${"1".repeat(32)}</price:id>`,
      );
      expect(serialized).toContain(
        "<price:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>EUR</cmdty:id></price:commodity>",
      );
      expect(serialized).toContain("<price:source>user:price-editor</price:source>");
      expect(serialized).not.toContain("<price:type>");
      expect(serialized).toContain("<price:value>108/100</price:value>");

      const reparsed = GncXmlDocument.parse(serialized);
      expect(reparsed.price(price.guid)).toEqual(price);
    });

    it("writes price:type only when given, before price:value", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      doc.createPrice(
        {
          commodity: AAPL,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          type: "last",
          value: money(19000n, 100n),
        },
        guidFrom("2".repeat(32)),
      );
      const serialized = doc.serialize();
      expect(serialized).toContain(
        "<price:type>last</price:type><price:value>19000/100</price:value>",
      );
    });

    it("omits <gnc:pricedb> entirely when the book has no prices", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      expect(doc.serialize()).not.toContain("gnc:pricedb");
    });

    it("removes <gnc:pricedb> once the last price is deleted", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const price = doc.createPrice(
        {
          commodity: EUR,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(108n, 100n),
        },
        guidFrom("1".repeat(32)),
      );
      expect(doc.serialize()).toContain("gnc:pricedb");
      doc.deletePrice(price.guid);
      expect(doc.prices()).toEqual([]);
      expect(doc.serialize()).not.toContain("gnc:pricedb");
      // Deleting an unknown price is a silent no-op, matching deleteAccount/deleteBudget.
      expect(() => doc.deletePrice("f".repeat(32))).not.toThrow();
    });

    it("supports multiple prices across different commodity/currency pairs", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      doc.createPrice(
        {
          commodity: EUR,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(108n, 100n),
        },
        guidFrom("1".repeat(32)),
      );
      doc.createPrice(
        {
          commodity: AAPL,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(19000n, 100n),
        },
        guidFrom("2".repeat(32)),
      );
      expect(doc.prices()).toHaveLength(2);
    });

    it("rejects a duplicate price guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      doc.createPrice(
        {
          commodity: EUR,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(108n, 100n),
        },
        guidFrom("1".repeat(32)),
      );
      expect(() =>
        doc.createPrice(
          {
            commodity: AAPL,
            currency: USD,
            time: "2026-01-15 00:00:00 +0000",
            value: money(1n, 1n),
          },
          guidFrom("1".repeat(32)),
        ),
      ).toThrow(GncXmlError);
    });

    it("updates time, value and type independently, adding and removing type", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      const price = doc.createPrice(
        {
          commodity: EUR,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(108n, 100n),
        },
        guidFrom("1".repeat(32)),
      );

      const withTime = doc.updatePrice(price.guid, {
        time: "2026-02-01 00:00:00 +0000",
      });
      expect(withTime.time).toBe("2026-02-01 00:00:00 +0000");
      expect(withTime.value).toEqual(money(108n, 100n));

      const withValue = doc.updatePrice(price.guid, { value: money(110n, 100n) });
      expect(withValue.value).toEqual(money(110n, 100n));

      const withType = doc.updatePrice(price.guid, { type: "last" });
      expect(withType.type).toBe("last");
      expect(doc.serialize()).toContain(
        "<price:type>last</price:type><price:value>110/100</price:value>",
      );

      // Replacing an already-set type updates it in place.
      const withReplacedType = doc.updatePrice(price.guid, { type: "transaction" });
      expect(withReplacedType.type).toBe("transaction");

      const withoutType = doc.updatePrice(price.guid, { type: "" });
      expect(withoutType.type).toBe("");
      expect(doc.serialize()).not.toContain("<price:type>");

      // Setting the same (now-absent) type again is a no-op, not an error.
      const stillWithoutType = doc.updatePrice(price.guid, { type: "" });
      expect(stillWithoutType.type).toBe("");
    });

    it("rejects updating an unknown price", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      expect(() => doc.updatePrice("f".repeat(32), { value: money(1n, 1n) })).toThrow(
        GncXmlError,
      );
    });

    it("returns undefined for an unknown price guid", async () => {
      const doc = GncXmlDocument.parse(await loadFixtureXml());
      expect(doc.price("f".repeat(32))).toBeUndefined();
    });

    it("creates <gnc:pricedb> right after book:id when the book declares no commodities", () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty" xmlns:price="http://www.gnucash.org/XML/price" xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:book version="2.0.0">
<book:id type="guid">${"b".repeat(32)}</book:id>
</gnc:book>
</gnc-v2>`;
      const doc = GncXmlDocument.parse(xml);
      const price = doc.createPrice(
        {
          commodity: EUR,
          currency: USD,
          time: "2026-01-15 00:00:00 +0000",
          value: money(108n, 100n),
        },
        guidFrom("1".repeat(32)),
      );
      expect(doc.price(price.guid)).toEqual(price);
      const serialized = doc.serialize();
      // After book:id (never before it), even with no commodity to anchor on.
      expect(serialized.indexOf("<book:id")).toBeLessThan(
        serialized.indexOf("<gnc:pricedb"),
      );
    });

    it("defaults missing commodity, currency, time, source and value on a malformed price entry", () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book" xmlns:price="http://www.gnucash.org/XML/price">
<gnc:book version="2.0.0">
<book:id type="guid">${"b".repeat(32)}</book:id>
<gnc:pricedb version="1">
  <price>
    <price:id type="guid">${"8".repeat(32)}</price:id>
  </price>
</gnc:pricedb>
</gnc:book>
</gnc-v2>`;
      const doc = GncXmlDocument.parse(xml);
      expect(doc.price("8".repeat(32))).toEqual({
        guid: "8".repeat(32),
        commodity: { space: "ISO4217", id: "USD" },
        currency: { space: "ISO4217", id: "USD" },
        time: "",
        source: "",
        type: "",
        value: money(0n, 1n),
      });

      // Updating a malformed entry with no price:time wrapper is a safe no-op for that field...
      const updated = doc.updatePrice("8".repeat(32), {
        time: "2026-01-01 00:00:00 +0000",
        type: "last",
      });
      expect(updated.time).toBe("");
      // ...but adding a type still works, inserted even with no price:value to anchor before.
      expect(updated.type).toBe("last");
      expect(doc.serialize()).toContain("<price:type>last</price:type>");
    });

    describe("nearestPrice", () => {
      function withThreePrices(doc: GncXmlDocument) {
        doc.createPrice(
          {
            commodity: EUR,
            currency: USD,
            time: "2026-01-01 00:00:00 +0000",
            value: money(105n, 100n),
          },
          guidFrom("1".repeat(32)),
        );
        doc.createPrice(
          {
            commodity: EUR,
            currency: USD,
            time: "2026-01-10 00:00:00 +0000",
            value: money(108n, 100n),
          },
          guidFrom("2".repeat(32)),
        );
        doc.createPrice(
          {
            commodity: EUR,
            currency: USD,
            time: "2026-01-20 00:00:00 +0000",
            value: money(110n, 100n),
          },
          guidFrom("3".repeat(32)),
        );
      }

      it("returns an exact match", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        withThreePrices(doc);
        expect(doc.nearestPrice(EUR, USD, "2026-01-10")?.value).toEqual(
          money(108n, 100n),
        );
      });

      it("picks the closer of two surrounding prices", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        withThreePrices(doc);
        // 2026-01-12 is 2 days after the 10th, 8 days before the 20th.
        expect(doc.nearestPrice(EUR, USD, "2026-01-12")?.value).toEqual(
          money(108n, 100n),
        );
        // 2026-01-16 is 6 days after the 10th, 4 days before the 20th.
        expect(doc.nearestPrice(EUR, USD, "2026-01-16")?.value).toEqual(
          money(110n, 100n),
        );
      });

      it("picks the earliest price when asking before it, and the latest when asking after", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        withThreePrices(doc);
        expect(doc.nearestPrice(EUR, USD, "2025-12-01")?.value).toEqual(
          money(105n, 100n),
        );
        expect(doc.nearestPrice(EUR, USD, "2026-06-01")?.value).toEqual(
          money(110n, 100n),
        );
      });

      it("returns null when no price exists for the pair", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        withThreePrices(doc);
        expect(doc.nearestPrice(AAPL, USD, "2026-01-10")).toBeNull();
      });
    });

    describe("convertMoney", () => {
      it("returns the value unchanged for identical commodities", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        expect(doc.convertMoney(money(100n, 1n), USD, USD, "2026-01-10")).toEqual(
          money(100n, 1n),
        );
      });

      it("converts using the nearest price", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        doc.createPrice(
          {
            commodity: EUR,
            currency: USD,
            time: "2026-01-10 00:00:00 +0000",
            value: money(2n, 1n),
          },
          guidFrom("1".repeat(32)),
        );
        expect(doc.convertMoney(money(50n, 1n), EUR, USD, "2026-01-10")).toEqual(
          money(100n, 1n),
        );
      });

      it("returns null when no price exists for the pair", async () => {
        const doc = GncXmlDocument.parse(await loadFixtureXml());
        expect(doc.convertMoney(money(50n, 1n), EUR, USD, "2026-01-10")).toBeNull();
      });
    });

    it("round-trips a hand-written fixture with no price:type, defaulting it to empty", () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty" xmlns:price="http://www.gnucash.org/XML/price" xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:book version="2.0.0">
<book:id type="guid">${"b".repeat(32)}</book:id>
<gnc:pricedb version="1">
  <price>
    <price:id type="guid">${"9".repeat(32)}</price:id>
    <price:commodity><cmdty:space>NASDAQ</cmdty:space><cmdty:id>CORL</cmdty:id></price:commodity>
    <price:currency><cmdty:space>ISO4217</cmdty:space><cmdty:id>USD</cmdty:id></price:currency>
    <price:time><ts:date>2001-03-26 12:59:00 -0800</ts:date></price:time>
    <price:source>Finance::Quote</price:source>
    <price:value>237500000/100000000</price:value>
  </price>
</gnc:pricedb>
</gnc:book>
</gnc-v2>`;
      const doc = GncXmlDocument.parse(xml);
      expect(doc.price("9".repeat(32))).toEqual({
        guid: "9".repeat(32),
        commodity: { space: "NASDAQ", id: "CORL" },
        currency: { space: "ISO4217", id: "USD" },
        time: "2001-03-26 12:59:00 -0800",
        source: "Finance::Quote",
        type: "",
        value: money(237500000n, 100000000n),
      });
      const reparsed = GncXmlDocument.parse(doc.serialize());
      expect(reparsed.price("9".repeat(32))).toEqual(doc.price("9".repeat(32)));
    });
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

  it("creates a vendor, a bill with lines, and posts it as a real transaction", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const vendorGuid = guidFrom("1".repeat(32));

    const vendor = doc.createVendor(
      {
        name: "Acme Supplies",
        vendorNumber: "V-0001",
        email: "ap@acme.test",
        currency: USD,
      },
      vendorGuid,
    );
    expect(vendor.name).toBe("Acme Supplies");
    expect(doc.vendors()).toHaveLength(1);
    expect(doc.vendor(vendorGuid)?.vendorNumber).toBe("V-0001");

    doc.updateVendor(vendorGuid, { name: "Acme Supplies Inc" });
    expect(doc.vendor(vendorGuid)?.name).toBe("Acme Supplies Inc");

    const billGuid = guidFrom("2".repeat(32));
    const bill = doc.createBill(
      { vendorGuid, billNumber: "BILL-1001", dateOpened: "2026-03-01", currency: USD },
      billGuid,
    );
    expect(bill.datePosted).toBeNull();
    expect(doc.bills()).toHaveLength(1);
    // A bill shares GncInvoice with customer invoices but must never show
    // up as one, and vice versa.
    expect(doc.invoices()).toHaveLength(0);

    const lineGuid = guidFrom("3".repeat(32));
    const entry = doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-01",
        description: "Office supplies",
        quantity: money(1n, 1n),
        unitPrice: money(8000n, 100n),
        expenseAccountGuid: SALARY,
      },
      lineGuid,
    );
    expect(entry.unitPrice).toEqual(money(8000n, 100n));
    expect(doc.billEntries(billGuid)).toHaveLength(1);

    const txGuid = guidFrom("4".repeat(32));
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-03-01 00:00:00 +0000",
        dateEntered: "2026-03-01 00:00:00 +0000",
        description: "Bill BILL-1001",
        splits: [
          { accountGuid: SALARY, value: money(8000n, 100n) },
          { accountGuid: BANK, value: money(-8000n, 100n) },
        ],
      },
      {
        transaction: txGuid,
        splits: [guidFrom("5".repeat(32)), guidFrom("6".repeat(32))],
      },
    );
    doc.markBillPosted(billGuid, "2026-03-01", txGuid, BANK);

    const posted = doc.bill(billGuid);
    expect(posted?.datePosted).toBe("2026-03-01");
    expect(posted?.postedTransactionGuid).toBe(txGuid);
    expect(posted?.payableAccountGuid).toBe(BANK);

    const reparsed = GncXmlDocument.parse(doc.serialize());
    expect(reparsed.vendors()).toHaveLength(1);
    expect(reparsed.bills()).toHaveLength(1);
    expect(reparsed.billEntries(billGuid)).toHaveLength(1);
    expect(reparsed.bill(billGuid)?.datePosted).toBe("2026-03-01");
    expect(reparsed.invoices()).toHaveLength(0);

    doc.deleteVendor(vendorGuid);
    expect(doc.vendor(vendorGuid)).toBeUndefined();
  });

  it("refuses to delete a vendor that still has bills (checked by the caller)", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const vendorGuid = guidFrom("1".repeat(32));
    doc.createVendor({ name: "Acme", currency: USD }, vendorGuid);
    const billGuid = guidFrom("2".repeat(32));
    doc.createBill(
      { vendorGuid, billNumber: "BILL-1", dateOpened: "2026-03-01", currency: USD },
      billGuid,
    );
    expect(doc.vendorInUse(vendorGuid)).toBe(true);

    doc.deleteBill(billGuid);
    expect(doc.bill(billGuid)).toBeUndefined();
    expect(doc.vendorInUse(vendorGuid)).toBe(false);
  });

  it("no-ops deleting an unknown vendor, bill or bill entry, and rejects unknown ids", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const unknown = guidFrom("f".repeat(32));
    expect(() => doc.deleteVendor(unknown)).not.toThrow();
    expect(() => doc.deleteBill(unknown)).not.toThrow();
    expect(() => doc.deleteBillEntry(unknown)).not.toThrow();
    expect(() => doc.updateVendor(unknown, { name: "x" })).toThrow(GncXmlError);
    expect(() => doc.markBillPosted(unknown, "2026-01-01", unknown, unknown)).toThrow(
      GncXmlError,
    );
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

  it("rejects a duplicate invoice, deletes an entry directly, and clears only its own invoice's entries", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const customerGuid = guidFrom("c".repeat(32));
    doc.createCustomer({ name: "Acme", currency: USD }, customerGuid);
    const invoiceGuid = guidFrom("d".repeat(32));
    doc.createInvoice(
      { customerGuid, invoiceNumber: "INV-1", dateOpened: "2026-03-01", currency: USD },
      invoiceGuid,
    );
    expect(() =>
      doc.createInvoice(
        {
          customerGuid,
          invoiceNumber: "INV-2",
          dateOpened: "2026-03-02",
          currency: USD,
        },
        invoiceGuid,
      ),
    ).toThrow(GncXmlError);

    const otherInvoiceGuid = guidFrom("e".repeat(32));
    doc.createInvoice(
      { customerGuid, invoiceNumber: "INV-3", dateOpened: "2026-03-01", currency: USD },
      otherInvoiceGuid,
    );
    const keptLine = doc.addInvoiceEntry(
      {
        invoiceGuid: otherInvoiceGuid,
        date: "2026-03-01",
        description: "Kept",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        incomeAccountGuid: SALARY,
      },
      guidFrom("f".repeat(32)),
    );
    const removedLine = doc.addInvoiceEntry(
      {
        invoiceGuid,
        date: "2026-03-01",
        description: "Removed",
        quantity: money(1n, 1n),
        unitPrice: money(200n, 100n),
        incomeAccountGuid: SALARY,
      },
      guidFrom("1".repeat(32)),
    );
    doc.deleteInvoiceEntry(removedLine.guid);
    expect(doc.invoiceEntries(invoiceGuid)).toHaveLength(0);
    expect(doc.invoiceEntries(otherInvoiceGuid)).toHaveLength(1);

    // Deleting an invoice only clears its own entries, not a sibling's.
    doc.deleteInvoice(invoiceGuid);
    expect(doc.invoiceEntries(otherInvoiceGuid).map((entry) => entry.guid)).toEqual([
      keptLine.guid,
    ]);

    expect(() =>
      doc.markInvoicePosted(
        guidFrom("f".repeat(32)),
        "2026-01-01",
        invoiceGuid,
        invoiceGuid,
      ),
    ).toThrow(GncXmlError);
  });

  it("sorts invoice entries by date, then by guid on the same day", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const customerGuid = guidFrom("c".repeat(32));
    doc.createCustomer({ name: "Acme", currency: USD }, customerGuid);
    const invoiceGuid = guidFrom("d".repeat(32));
    doc.createInvoice(
      { customerGuid, invoiceNumber: "INV-1", dateOpened: "2026-03-01", currency: USD },
      invoiceGuid,
    );
    const second = doc.addInvoiceEntry(
      {
        invoiceGuid,
        date: "2026-03-05",
        description: "Second day",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        incomeAccountGuid: SALARY,
      },
      guidFrom("9".repeat(32)),
    );
    const sameDayLater = doc.addInvoiceEntry(
      {
        invoiceGuid,
        date: "2026-03-01",
        description: "Same day, higher guid",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        incomeAccountGuid: SALARY,
      },
      guidFrom("2".repeat(32)),
    );
    const sameDayEarlier = doc.addInvoiceEntry(
      {
        invoiceGuid,
        date: "2026-03-01",
        description: "Same day, lower guid",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        incomeAccountGuid: SALARY,
      },
      guidFrom("1".repeat(32)),
    );
    expect(doc.invoiceEntries(invoiceGuid).map((entry) => entry.guid)).toEqual([
      sameDayEarlier.guid,
      sameDayLater.guid,
      second.guid,
    ]);
  });

  it("creates a vendor, a bill with lines, and posts it as a real transaction", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const vendorGuid = guidFrom("1".repeat(32));

    const vendor = doc.createVendor(
      {
        name: "Acme Supplies",
        vendorNumber: "V-0001",
        email: "ap@acme.test",
        currency: USD,
      },
      vendorGuid,
    );
    expect(vendor.name).toBe("Acme Supplies");
    expect(doc.vendors()).toHaveLength(1);
    expect(doc.vendor(vendorGuid)?.vendorNumber).toBe("V-0001");

    doc.updateVendor(vendorGuid, { name: "Acme Supplies Inc" });
    expect(doc.vendor(vendorGuid)?.name).toBe("Acme Supplies Inc");

    const billGuid = guidFrom("2".repeat(32));
    const bill = doc.createBill(
      { vendorGuid, billNumber: "BILL-1001", dateOpened: "2026-03-01", currency: USD },
      billGuid,
    );
    expect(bill.datePosted).toBeNull();
    expect(doc.bills()).toHaveLength(1);
    // A bill shares GncInvoice with customer invoices but must never show
    // up as one, and vice versa.
    expect(doc.invoices()).toHaveLength(0);
    expect(() =>
      doc.createBill(
        {
          vendorGuid,
          billNumber: "BILL-DUPE",
          dateOpened: "2026-03-01",
          currency: USD,
        },
        billGuid,
      ),
    ).toThrow(GncXmlError);

    const lineGuid = guidFrom("3".repeat(32));
    const entry = doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-01",
        description: "Office supplies",
        quantity: money(1n, 1n),
        unitPrice: money(8000n, 100n),
        expenseAccountGuid: SALARY,
      },
      lineGuid,
    );
    expect(entry.unitPrice).toEqual(money(8000n, 100n));
    expect(doc.billEntries(billGuid)).toHaveLength(1);
    doc.deleteBillEntry(lineGuid);
    expect(doc.billEntries(billGuid)).toHaveLength(0);
    doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-01",
        description: "Office supplies",
        quantity: money(1n, 1n),
        unitPrice: money(8000n, 100n),
        expenseAccountGuid: SALARY,
      },
      lineGuid,
    );

    const txGuid = guidFrom("4".repeat(32));
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-03-01 00:00:00 +0000",
        dateEntered: "2026-03-01 00:00:00 +0000",
        description: "Bill BILL-1001",
        splits: [
          { accountGuid: SALARY, value: money(8000n, 100n) },
          { accountGuid: BANK, value: money(-8000n, 100n) },
        ],
      },
      {
        transaction: txGuid,
        splits: [guidFrom("5".repeat(32)), guidFrom("6".repeat(32))],
      },
    );
    doc.markBillPosted(billGuid, "2026-03-01", txGuid, BANK);

    const posted = doc.bill(billGuid);
    expect(posted?.datePosted).toBe("2026-03-01");
    expect(posted?.postedTransactionGuid).toBe(txGuid);
    expect(posted?.payableAccountGuid).toBe(BANK);

    const reparsed = GncXmlDocument.parse(doc.serialize());
    expect(reparsed.vendors()).toHaveLength(1);
    expect(reparsed.bills()).toHaveLength(1);
    expect(reparsed.billEntries(billGuid)).toHaveLength(1);
    expect(reparsed.bill(billGuid)?.datePosted).toBe("2026-03-01");
    expect(reparsed.invoices()).toHaveLength(0);

    doc.deleteVendor(vendorGuid);
    expect(doc.vendor(vendorGuid)).toBeUndefined();
  });

  it("refuses to delete a vendor that still has bills, and only clears its own bill's entries", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const vendorGuid = guidFrom("1".repeat(32));
    doc.createVendor({ name: "Acme", currency: USD }, vendorGuid);
    const billGuid = guidFrom("2".repeat(32));
    doc.createBill(
      { vendorGuid, billNumber: "BILL-1", dateOpened: "2026-03-01", currency: USD },
      billGuid,
    );
    expect(doc.vendorInUse(vendorGuid)).toBe(true);

    const otherBillGuid = guidFrom("3".repeat(32));
    doc.createBill(
      { vendorGuid, billNumber: "BILL-2", dateOpened: "2026-03-05", currency: USD },
      otherBillGuid,
    );
    const kept = doc.addBillEntry(
      {
        billGuid: otherBillGuid,
        date: "2026-03-05",
        description: "Kept",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        expenseAccountGuid: SALARY,
      },
      guidFrom("4".repeat(32)),
    );
    doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-01",
        description: "Removed",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        expenseAccountGuid: SALARY,
      },
      guidFrom("5".repeat(32)),
    );

    doc.deleteBill(billGuid);
    expect(doc.bill(billGuid)).toBeUndefined();
    // The vendor's other bill still exists.
    expect(doc.vendorInUse(vendorGuid)).toBe(true);
    expect(doc.billEntries(otherBillGuid).map((entry) => entry.guid)).toEqual([
      kept.guid,
    ]);

    doc.deleteBill(otherBillGuid);
    expect(doc.vendorInUse(vendorGuid)).toBe(false);
  });

  it("no-ops deleting an unknown vendor, bill or bill entry, and rejects unknown ids", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const unknown = guidFrom("f".repeat(32));
    expect(() => doc.deleteVendor(unknown)).not.toThrow();
    expect(() => doc.deleteBill(unknown)).not.toThrow();
    expect(() => doc.deleteBillEntry(unknown)).not.toThrow();
    expect(() => doc.updateVendor(unknown, { name: "x" })).toThrow(GncXmlError);
    expect(() => doc.markBillPosted(unknown, "2026-01-01", unknown, unknown)).toThrow(
      GncXmlError,
    );
  });

  it("updates individual vendor fields independently, including on a vendor with no address block", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:vendor="http://www.gnucash.org/XML/vendor" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty">
<gnc:book version="2.0.0">
<book:id type="guid">${"7".repeat(32)}</book:id>
<gnc:GncVendor version="2.0.0">
  <vendor:guid type="guid">${"8".repeat(32)}</vendor:guid>
  <vendor:name>No Address LLC</vendor:name>
  <vendor:id>V-0002</vendor:id>
  <vendor:active>1</vendor:active>
</gnc:GncVendor>
</gnc:book>
</gnc-v2>`);
    const guid = "8".repeat(32);
    expect(doc.vendor(guid)?.addressLine1).toBe("");

    doc.updateVendor(guid, { vendorNumber: "V-0003" });
    expect(doc.vendor(guid)?.vendorNumber).toBe("V-0003");
    expect(doc.vendor(guid)?.name).toBe("No Address LLC");

    doc.updateVendor(guid, { notes: "Reliable", active: false });
    expect(doc.vendor(guid)).toMatchObject({ notes: "Reliable", active: false });

    doc.updateVendor(guid, { addressLine1: "500 Market St" });
    expect(doc.vendor(guid)?.addressLine1).toBe("500 Market St");
  });

  it("reads a bill missing its owner, and filters out a malformed bill entry", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:invoice="http://www.gnucash.org/XML/invoice" xmlns:entry="http://www.gnucash.org/XML/entry" xmlns:book="http://www.gnucash.org/XML/book" xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:book version="2.0.0">
<book:id type="guid">${"9".repeat(32)}</book:id>
<gnc:GncInvoice version="2.0.0">
  <invoice:guid type="guid">${"a".repeat(32)}</invoice:guid>
  <invoice:id>BILL-0</invoice:id>
  <invoice:owner version="2.0.0"><owner:type>gncVendor</owner:type></invoice:owner>
  <invoice:opened><ts:date>2026-01-01</ts:date></invoice:opened>
  <invoice:active>1</invoice:active>
</gnc:GncInvoice>
<gnc:GncEntry version="2.0.0">
  <entry:guid type="guid">${"b".repeat(32)}</entry:guid>
</gnc:GncEntry>
</gnc:book>
</gnc-v2>`);
    const billGuid = "a".repeat(32);
    const bill = doc.bill(billGuid);
    expect(bill?.vendorGuid).toBe("");
    expect(bill?.datePosted).toBeNull();
    expect(bill?.postedTransactionGuid).toBeNull();
    expect(bill?.payableAccountGuid).toBeNull();
    expect(doc.billEntries(billGuid)).toHaveLength(0);
    expect(doc.bills()).toHaveLength(1);
    expect(doc.invoices()).toHaveLength(0);
  });

  it("sorts bill entries by date, then by guid on the same day", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const vendorGuid = guidFrom("1".repeat(32));
    doc.createVendor({ name: "Acme", currency: USD }, vendorGuid);
    const billGuid = guidFrom("2".repeat(32));
    doc.createBill(
      { vendorGuid, billNumber: "BILL-1", dateOpened: "2026-03-01", currency: USD },
      billGuid,
    );
    const second = doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-05",
        description: "Second day",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        expenseAccountGuid: SALARY,
      },
      guidFrom("9".repeat(32)),
    );
    const sameDayLater = doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-01",
        description: "Same day, higher guid",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        expenseAccountGuid: SALARY,
      },
      guidFrom("4".repeat(32)),
    );
    const sameDayEarlier = doc.addBillEntry(
      {
        billGuid,
        date: "2026-03-01",
        description: "Same day, lower guid",
        quantity: money(1n, 1n),
        unitPrice: money(100n, 100n),
        expenseAccountGuid: SALARY,
      },
      guidFrom("3".repeat(32)),
    );
    expect(doc.billEntries(billGuid).map((entry) => entry.guid)).toEqual([
      sameDayEarlier.guid,
      sameDayLater.guid,
      second.guid,
    ]);
  });
});
