// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { handleRequest } from "./cli-bridge.ts";
import type { Ledger } from "./ledger.ts";

const ASSET = "1".repeat(32);
const EQUITY = "2".repeat(32);
const INCOME = "3".repeat(32);
const EXPENSE = "4".repeat(32);
const TX1 = "a".repeat(32);
const TX2 = "b".repeat(32);

function reset() {
  return handleRequest(undefined, {
    op: "reset",
    accounts: [
      { id: ASSET, name: "Bank", type: "ASSET" },
      { id: EQUITY, name: "Opening Balances", type: "EQUITY" },
      { id: INCOME, name: "Salary", type: "INCOME" },
      { id: EXPENSE, name: "Rent", type: "EXPENSE" },
    ],
  });
}

describe("cli-bridge: op handling", () => {
  it("resets, posts, and reports a balanced trial balance/balance sheet/income statement/verify", () => {
    const { response: resetResponse, nextState: afterReset } = reset();
    expect(resetResponse).toEqual({ ok: true });
    expect(afterReset).toBeTruthy();

    const { response: postResponse, nextState: afterPost } = handleRequest(afterReset, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Opening deposit",
        splits: [
          { accountId: ASSET, value: { num: "100000", denom: "100" } },
          { accountId: EQUITY, value: { num: "-100000", denom: "100" } },
        ],
      },
    });
    expect(postResponse).toEqual({ ok: true });

    const { response: salaryResponse, nextState: afterSalary } = handleRequest(
      afterPost,
      {
        op: "post",
        transaction: {
          id: TX2,
          date: "2026-01-15",
          description: "Pay rent from salary",
          splits: [
            { accountId: INCOME, value: { num: "-50000", denom: "100" } },
            { accountId: EXPENSE, value: { num: "20000", denom: "100" } },
            { accountId: ASSET, value: { num: "30000", denom: "100" } },
          ],
        },
      },
    );
    expect(salaryResponse).toEqual({ ok: true });

    const trial = handleRequest(afterSalary, { op: "trialBalance" });
    expect(trial.response.ok).toBe(true);
    if (!trial.response.ok) throw new Error("expected ok");
    expect(trial.response.result).toMatchObject({ balanced: true });

    const sheet = handleRequest(afterSalary, {
      op: "balanceSheet",
      asOf: "2026-01-31",
    });
    expect(sheet.response.ok).toBe(true);
    if (!sheet.response.ok) throw new Error("expected ok");
    expect(sheet.response.result).toMatchObject({
      balanced: true,
      assets: { num: "1300", denom: "1" },
    });

    const income = handleRequest(afterSalary, {
      op: "incomeStatement",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(income.response.ok).toBe(true);
    if (!income.response.ok) throw new Error("expected ok");
    expect(income.response.result).toMatchObject({
      revenue: { num: "500", denom: "1" },
      expenses: { num: "200", denom: "1" },
      netIncome: { num: "300", denom: "1" },
    });

    const verify = handleRequest(afterSalary, { op: "verify", asOf: "2026-01-31" });
    expect(verify.response).toEqual({ ok: true, result: { failures: [] } });

    const exit = handleRequest(afterSalary, { op: "exit" });
    expect(exit.response).toEqual({ ok: true });
    expect(exit.nextState).toBe(afterSalary);
  });

  it("carries ledger state across a longer sequence of requests", () => {
    let state: Ledger | undefined;
    const steps: Array<{ op: string; [key: string]: unknown }> = [
      {
        op: "reset",
        accounts: [
          { id: ASSET, name: "Bank", type: "ASSET" },
          { id: EQUITY, name: "Opening Balances", type: "EQUITY" },
        ],
      },
      {
        op: "post",
        transaction: {
          id: TX1,
          date: "2026-02-01",
          description: "Open",
          splits: [
            { accountId: ASSET, value: { num: "500", denom: "1" } },
            { accountId: EQUITY, value: { num: "-500", denom: "1" } },
          ],
        },
      },
      { op: "trialBalance" },
    ];
    for (const step of steps) {
      const { response, nextState } = handleRequest(state, step);
      expect(response.ok).toBe(true);
      state = nextState;
    }
    expect(state?.transactions).toHaveLength(1);
  });
});

describe("cli-bridge: validation and errors", () => {
  it("rejects any op but reset/exit before the ledger is set up", () => {
    for (const request of [
      { op: "post", transaction: {} },
      { op: "trialBalance" },
      { op: "balanceSheet", asOf: "2026-01-01" },
      { op: "incomeStatement", from: "2026-01-01", to: "2026-01-31" },
      { op: "verify", asOf: "2026-01-01" },
    ]) {
      const { response, nextState } = handleRequest(undefined, request);
      expect(response).toEqual({
        ok: false,
        error: { code: "NO_LEDGER", message: expect.any(String) },
      });
      expect(nextState).toBeUndefined();
    }
  });

  it("surfaces every LedgerError code from reset and post without crashing", () => {
    const { nextState: ledger } = reset();

    const duplicateAccount = handleRequest(undefined, {
      op: "reset",
      accounts: [
        { id: ASSET, name: "Bank", type: "ASSET" },
        { id: ASSET, name: "Bank Again", type: "ASSET" },
      ],
    });
    expect(duplicateAccount.response).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_ACCOUNT" },
    });

    const tooFew = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: [{ accountId: ASSET, value: { num: "1", denom: "1" } }],
      },
    });
    expect(tooFew.response).toMatchObject({
      ok: false,
      error: { code: "TOO_FEW_SPLITS" },
    });
    expect(tooFew.nextState).toBe(ledger);

    const unbalanced = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: [
          { accountId: ASSET, value: { num: "100", denom: "1" } },
          { accountId: EQUITY, value: { num: "-90", denom: "1" } },
        ],
      },
    });
    expect(unbalanced.response).toMatchObject({
      ok: false,
      error: { code: "UNBALANCED_TRANSACTION" },
    });

    const badDate = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "01/01/2026",
        description: "Bad",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "1" } },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(badDate.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATE" },
    });

    const unknownAccount = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "1" } },
          { accountId: "f".repeat(32), value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(unknownAccount.response).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_ACCOUNT" },
    });

    const posted = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Fine",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "1" } },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    const duplicateTransaction = handleRequest(posted.nextState, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-02",
        description: "Again",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "1" } },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(duplicateTransaction.response).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_TRANSACTION" },
    });
  });

  it("rejects an invalid GUID without crashing", () => {
    const { nextState: ledger } = reset();
    const { response, nextState } = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: "not-a-guid",
        date: "2026-01-01",
        description: "Bad",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "1" } },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(nextState).toBe(ledger);
  });

  it("rejects invalid money (non-numeric string, zero and negative denominator) without crashing", () => {
    const { nextState: ledger } = reset();
    const cases = [
      { num: "not-a-number", denom: "1" },
      { num: "1", denom: "0" },
      { num: "1", denom: "-1" },
    ];
    for (const value of cases) {
      const { response, nextState } = handleRequest(ledger, {
        op: "post",
        transaction: {
          id: TX1,
          date: "2026-01-01",
          description: "Bad",
          splits: [
            { accountId: ASSET, value },
            { accountId: EQUITY, value: { num: "-1", denom: "1" } },
          ],
        },
      });
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("expected a validation failure");
      expect(response.error.code).toBe("VALIDATION_ERROR");
      expect(nextState).toBe(ledger);
    }
  });

  it("rejects an unknown op and a non-object request without crashing", () => {
    const unknownOp = handleRequest(undefined, { op: "frobnicate" });
    expect(unknownOp.response).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_OP" },
    });

    const notAnObject = handleRequest(undefined, "just a string");
    expect(notAnObject.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const missingOp = handleRequest(undefined, { accounts: [] });
    expect(missingOp.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects an unknown account type without inventing a mapping", () => {
    const { response } = handleRequest(undefined, {
      op: "reset",
      accounts: [{ id: ASSET, name: "Bank", type: "SAVINGS" }],
    });
    expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("rejects a blank required or optional string field", () => {
    const blankDescription = handleRequest(reset().nextState, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "1" } },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(blankDescription.response).toMatchObject({
      ok: false,
      error: { code: "MISSING_FIELD" },
    });

    const blankAsOf = handleRequest(reset().nextState, {
      op: "trialBalance",
      asOf: "",
    });
    expect(blankAsOf.response).toMatchObject({
      ok: false,
      error: { code: "MISSING_FIELD" },
    });

    const wrongTypeAsOf = handleRequest(reset().nextState, {
      op: "trialBalance",
      asOf: 123,
    });
    expect(wrongTypeAsOf.response).toMatchObject({
      ok: false,
      error: { code: "MISSING_FIELD" },
    });
  });

  it("accepts an optional asOf, parentId and transaction fraction when actually provided", () => {
    const { nextState: ledger } = reset();

    const withAsOf = handleRequest(ledger, { op: "trialBalance", asOf: "2026-01-01" });
    expect(withAsOf.response.ok).toBe(true);

    const child = "5".repeat(32);
    const withParent = handleRequest(undefined, {
      op: "reset",
      accounts: [
        { id: ASSET, name: "Assets", type: "ASSET" },
        { id: child, name: "Bank", type: "BANK", parentId: ASSET },
      ],
    });
    expect(withParent.response).toEqual({ ok: true });

    const withFraction = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Fine-grained fraction",
        fraction: "10000",
        splits: [
          { accountId: ASSET, value: { num: "1", denom: "10000" } },
          { accountId: EQUITY, value: { num: "-1", denom: "10000" } },
        ],
      },
    });
    expect(withFraction.response).toEqual({ ok: true });
  });

  it("rejects money, an account, a split or a transaction that is not an object", () => {
    const { nextState: ledger } = reset();

    const moneyNotAnObject = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: [
          { accountId: ASSET, value: "not an object" },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(moneyNotAnObject.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const moneyWrongFieldTypes = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: [
          { accountId: ASSET, value: { num: 1, denom: 1 } },
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(moneyWrongFieldTypes.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const accountNotAnObject = handleRequest(undefined, {
      op: "reset",
      accounts: ["not an object"],
    });
    expect(accountNotAnObject.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const splitNotAnObject = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: [
          "not an object",
          { accountId: EQUITY, value: { num: "-1", denom: "1" } },
        ],
      },
    });
    expect(splitNotAnObject.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const transactionNotAnObject = handleRequest(ledger, {
      op: "post",
      transaction: "not an object",
    });
    expect(transactionNotAnObject.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const splitsNotAnArray = handleRequest(ledger, {
      op: "post",
      transaction: {
        id: TX1,
        date: "2026-01-01",
        description: "Bad",
        splits: "not an array",
      },
    });
    expect(splitsNotAnArray.response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects a reset whose accounts field is not an array", () => {
    const { response } = handleRequest(undefined, {
      op: "reset",
      accounts: "not an array",
    });
    expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
});
