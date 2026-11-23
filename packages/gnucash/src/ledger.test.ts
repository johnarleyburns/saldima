// SPDX-License-Identifier: AGPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { guidFrom } from "./guid.ts";
import {
  type Account,
  accountBalance,
  balanceSheet,
  createLedger,
  incomeStatement,
  LedgerError,
  post,
  type Transaction,
  trialBalance,
  verifyLedger,
} from "./ledger.ts";
import { money } from "./money.ts";

const accounts: Account[] = [
  { id: guidFrom("1".repeat(32)), name: "Bank", type: "BANK" },
  { id: guidFrom("2".repeat(32)), name: "Card", type: "CREDIT" },
  { id: guidFrom("3".repeat(32)), name: "Opening Balances", type: "EQUITY" },
  { id: guidFrom("4".repeat(32)), name: "Sales", type: "INCOME" },
  { id: guidFrom("5".repeat(32)), name: "Rent", type: "EXPENSE" },
];

const bank = guidFrom("1".repeat(32));
const card = guidFrom("2".repeat(32));
const opening = guidFrom("3".repeat(32));
const sales = guidFrom("4".repeat(32));
const rent = guidFrom("5".repeat(32));

function txn(
  id: string,
  date: string,
  description: string,
  splits: Array<[string, bigint]>,
): Transaction {
  return {
    id: guidFrom(id.repeat(32).slice(0, 32)),
    date,
    description,
    splits: splits.map(([accountId, units]) => ({
      accountId: guidFrom(accountId.repeat(32).slice(0, 32)),
      value: money(units, 100n),
    })),
  };
}

function openingLedger() {
  const base = createLedger(accounts);
  return post(
    base,
    txn("a", "2025-01-01", "Opening balances", [
      [bank, 100_000n],
      [card, -20_000n],
      [opening, -80_000n],
    ]),
  );
}

describe("journal posting", () => {
  it("accepts a balanced opening entry and derives the account balance", () => {
    const ledger = openingLedger();
    expect(accountBalance(ledger, bank)).toEqual(money(1_000n, 1n));
    expect(accountBalance(ledger, card)).toEqual(money(-200n, 1n));
  });

  it("rejects an unbalanced transaction", () => {
    const base = createLedger(accounts);
    expect(() =>
      post(
        base,
        txn("b", "2025-01-01", "Broken", [
          [bank, 100n],
          [opening, -99n],
        ]),
      ),
    ).toThrow(LedgerError);
  });

  it("rejects unknown accounts, duplicate ids, and single-split transactions", () => {
    const base = createLedger(accounts);
    expect(() =>
      post(
        base,
        txn("c", "2025-01-01", "Unknown", [
          [bank, 100n],
          ["9", -100n],
        ]),
      ),
    ).toThrow(LedgerError);
    expect(() => post(base, txn("d", "2025-01-01", "Single", [[bank, 0n]]))).toThrow(
      LedgerError,
    );
    const ledger = openingLedger();
    expect(() =>
      post(
        ledger,
        txn("a", "2025-01-02", "Duplicate", [
          [bank, 100n],
          [opening, -100n],
        ]),
      ),
    ).toThrow(LedgerError);
  });

  it("honours as-of and period dates", () => {
    let ledger = openingLedger();
    ledger = post(
      ledger,
      txn("b", "2025-02-01", "Sale", [
        [bank, 20_000n],
        [sales, -20_000n],
      ]),
    );
    ledger = post(
      ledger,
      txn("c", "2025-02-02", "Rent", [
        [rent, 5_000n],
        [bank, -5_000n],
      ]),
    );
    expect(accountBalance(ledger, bank, "2025-01-31")).toEqual(money(1_000n, 1n));
    expect(accountBalance(ledger, bank)).toEqual(money(1_150n, 1n));
    const pnl = incomeStatement(ledger, "2025-02-01", "2025-02-28");
    expect(pnl.revenue).toEqual(money(200n, 1n));
    expect(pnl.expenses).toEqual(money(50n, 1n));
    expect(pnl.netIncome).toEqual(money(150n, 1n));
  });
});

describe("reports", () => {
  it("trial balance ties to zero on the opening scenario", () => {
    const tb = trialBalance(openingLedger());
    expect(tb.totalDebits).toEqual(money(1_000n, 1n));
    expect(tb.totalCredits).toEqual(money(1_000n, 1n));
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((row) => row.accountId === bank)?.debit).toEqual(
      money(1_000n, 1n),
    );
    expect(tb.rows.find((row) => row.accountId === card)?.credit).toEqual(
      money(200n, 1n),
    );
  });

  it("balance sheet satisfies A = L + E including retained earnings", () => {
    let ledger = openingLedger();
    ledger = post(
      ledger,
      txn("b", "2025-02-01", "Sale", [
        [bank, 20_000n],
        [sales, -20_000n],
      ]),
    );
    ledger = post(
      ledger,
      txn("c", "2025-02-02", "Rent", [
        [rent, 5_000n],
        [bank, -5_000n],
      ]),
    );
    const report = balanceSheet(ledger, "2025-02-28");
    expect(report.assets).toEqual(money(1_150n, 1n));
    expect(report.liabilities).toEqual(money(200n, 1n));
    expect(report.equity).toEqual(money(800n, 1n));
    expect(report.retainedEarnings).toEqual(money(150n, 1n));
    expect(report.totalLiabilitiesAndEquity).toEqual(money(1_150n, 1n));
    expect(report.balanced).toBe(true);
  });

  it("P&L presents income positive and expenses positive", () => {
    let ledger = openingLedger();
    ledger = post(
      ledger,
      txn("b", "2025-02-01", "Sale", [
        [bank, 20_000n],
        [sales, -20_000n],
      ]),
    );
    const report = incomeStatement(ledger, "2025-01-01", "2025-12-31");
    expect(report.revenue).toEqual(money(200n, 1n));
    expect(report.expenses).toEqual(money(0n, 1n));
    expect(report.netIncome).toEqual(money(200n, 1n));
  });
});

describe("property-based invariants", () => {
  it("every valid two-split journal keeps the trial balance and A = L + E", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { maxLength: 20 }),
        (amounts) => {
          let ledger = createLedger(accounts);
          let sequence = 0;
          for (const units of amounts) {
            sequence += 1;
            ledger = post(
              ledger,
              txn(
                sequence.toString(16).padStart(2, "0"),
                "2025-03-01",
                "Generated sale",
                [
                  [bank, units],
                  [sales, -units],
                ],
              ),
            );
          }
          expect(trialBalance(ledger).balanced).toBe(true);
          expect(balanceSheet(ledger, "2025-12-31").balanced).toBe(true);
        },
      ),
    );
  });

  it("mutating one split breaks the invariant", () => {
    const ledger = openingLedger();
    const broken = {
      ...ledger,
      transactions: ledger.transactions.map((transaction) => ({
        ...transaction,
        splits: transaction.splits.map((split, index) =>
          index === 0 ? { ...split, value: money(1n, 1n) } : split,
        ),
      })),
    };
    expect(verifyLedger(broken, "2025-12-31").map((failure) => failure.code)).toContain(
      "UNBALANCED_TRIAL_BALANCE",
    );
  });
});
