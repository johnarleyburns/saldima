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
