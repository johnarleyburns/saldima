// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure request/response handling for the accounting bridge (see
 * `cli.ts` for the stdin/stdout transport). Kept free of `process.*` so
 * it is directly unit-testable: every input is already-parsed JSON
 * (`unknown`), and every output is a plain object ready to serialize.
 *
 * This is transport and validation only -- no accounting rule is
 * reimplemented here, everything calls straight into `ledger.ts`.
 */

import { guidFrom } from "./guid.ts";
import {
  type Account,
  type AccountType,
  type BalanceSheet,
  balanceSheet,
  createLedger,
  type IncomeStatement,
  incomeStatement,
  type Ledger,
  LedgerError,
  post,
  type Split,
  type Transaction,
  type TrialBalance,
  trialBalance,
  verifyLedger,
} from "./ledger.ts";
import { type Money, money } from "./money.ts";

export interface WireMoney {
  readonly num: string;
  readonly denom: string;
}

export interface OkResponse {
  readonly ok: true;
  readonly result?: unknown;
}

export interface ErrorResponse {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type Response = OkResponse | ErrorResponse;

export interface HandleResult {
  readonly response: Response;
  readonly nextState: Ledger | undefined;
}

class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

const ACCOUNT_TYPES: ReadonlySet<string> = new Set<AccountType>([
  "ASSET",
  "BANK",
  "CASH",
  "CREDIT",
  "LIABILITY",
  "INCOME",
  "EXPENSE",
  "EQUITY",
  "RECEIVABLE",
  "PAYABLE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError("MISSING_FIELD", `missing or invalid field: ${field}`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError("MISSING_FIELD", `invalid field: ${field}`);
  }
  return value;
}

function toWireMoney(value: Money): WireMoney {
  return { num: value.num.toString(), denom: value.denom.toString() };
}

function fromWireMoney(value: unknown): Money {
  if (
    !isRecord(value) ||
    typeof value.num !== "string" ||
    typeof value.denom !== "string"
  ) {
    throw new BridgeError(
      "INVALID_REQUEST",
      `money must be {num, denom} decimal strings: ${JSON.stringify(value)}`,
    );
  }
  let num: bigint;
  let denom: bigint;
  try {
    num = BigInt(value.num);
    denom = BigInt(value.denom);
  } catch {
    throw new RangeError(
      `invalid decimal string in money value: ${JSON.stringify(value)}`,
    );
  }
  return money(num, denom);
}

function toAccountType(value: string): AccountType {
  if (!ACCOUNT_TYPES.has(value)) {
    throw new BridgeError("INVALID_REQUEST", `unknown account type: ${value}`);
  }
  return value as AccountType;
}

function toAccount(value: unknown): Account {
  if (!isRecord(value))
    throw new BridgeError("INVALID_REQUEST", "account must be an object");
  const id = guidFrom(requireString(value, "id"));
  const name = requireString(value, "name");
  const type = toAccountType(requireString(value, "type"));
  const parentIdRaw = optionalString(value, "parentId");
  return parentIdRaw === undefined
    ? { id, name, type }
    : { id, name, type, parentId: guidFrom(parentIdRaw) };
}

function toSplit(value: unknown): Split {
  if (!isRecord(value))
    throw new BridgeError("INVALID_REQUEST", "split must be an object");
  return {
    accountId: guidFrom(requireString(value, "accountId")),
    value: fromWireMoney(value.value),
  };
}

function toTransaction(value: unknown): Transaction {
  if (!isRecord(value)) {
    throw new BridgeError("INVALID_REQUEST", "transaction must be an object");
  }
  const id = guidFrom(requireString(value, "id"));
  const date = requireString(value, "date");
  const description = requireString(value, "description");
  const fractionRaw = optionalString(value, "fraction");
  const splitsRaw = value.splits;
  if (!Array.isArray(splitsRaw)) {
    throw new BridgeError("INVALID_REQUEST", "transaction.splits must be an array");
  }
  const splits = splitsRaw.map(toSplit);
  return fractionRaw === undefined
    ? { id, date, description, splits }
    : { id, date, description, splits, fraction: BigInt(fractionRaw) };
}

function wireTrialBalance(result: TrialBalance) {
  return {
    rows: result.rows.map((row) => ({
      accountId: row.accountId,
      name: row.name,
      type: row.type,
      debit: toWireMoney(row.debit),
      credit: toWireMoney(row.credit),
    })),
    totalDebits: toWireMoney(result.totalDebits),
    totalCredits: toWireMoney(result.totalCredits),
    balanced: result.balanced,
  };
}

function wireBalanceSheet(result: BalanceSheet) {
  return {
    assets: toWireMoney(result.assets),
    liabilities: toWireMoney(result.liabilities),
    equity: toWireMoney(result.equity),
    retainedEarnings: toWireMoney(result.retainedEarnings),
    totalLiabilitiesAndEquity: toWireMoney(result.totalLiabilitiesAndEquity),
    balanced: result.balanced,
  };
}

function wireIncomeStatement(result: IncomeStatement) {
  return {
    revenue: toWireMoney(result.revenue),
    expenses: toWireMoney(result.expenses),
    netIncome: toWireMoney(result.netIncome),
  };
}

function requireLedger(state: Ledger | undefined): Ledger {
  if (!state) throw new BridgeError("NO_LEDGER", "call reset before using the ledger");
  return state;
}

function errorResponse(error: unknown): ErrorResponse {
  if (error instanceof LedgerError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof BridgeError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof Error) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: error.message } };
  }
  return { ok: false, error: { code: "VALIDATION_ERROR", message: String(error) } };
}

/**
 * Handles one already-parsed request against the current ledger state
 * (`undefined` before the first `reset`), returning the response to send
 * back and the state to hold for the next call. Never throws: every
 * failure -- a `LedgerError`, an unknown op, a malformed field, an
 * invalid GUID or money value -- becomes an `ErrorResponse` with the
 * ledger state left unchanged.
 */
export function handleRequest(
  state: Ledger | undefined,
  request: unknown,
): HandleResult {
  try {
    if (!isRecord(request)) {
      throw new BridgeError("INVALID_REQUEST", "request must be a JSON object");
    }
    const op = request.op;
    if (typeof op !== "string") {
      throw new BridgeError("INVALID_REQUEST", "request.op must be a string");
    }

    switch (op) {
      case "reset": {
        const accountsRaw = request.accounts;
        if (!Array.isArray(accountsRaw)) {
          throw new BridgeError("INVALID_REQUEST", "accounts must be an array");
        }
        const accounts = accountsRaw.map(toAccount);
        const nextState = createLedger(accounts);
        return { response: { ok: true }, nextState };
      }
      case "post": {
        const ledger = requireLedger(state);
        const transaction = toTransaction(request.transaction);
        const nextState = post(ledger, transaction);
        return { response: { ok: true }, nextState };
      }
      case "trialBalance": {
        const ledger = requireLedger(state);
        const asOf = optionalString(request, "asOf");
        const result = trialBalance(ledger, asOf);
        return {
          response: { ok: true, result: wireTrialBalance(result) },
          nextState: state,
        };
      }
      case "balanceSheet": {
        const ledger = requireLedger(state);
        const asOf = requireString(request, "asOf");
        const result = balanceSheet(ledger, asOf);
        return {
          response: { ok: true, result: wireBalanceSheet(result) },
          nextState: state,
        };
      }
      case "incomeStatement": {
        const ledger = requireLedger(state);
        const from = requireString(request, "from");
        const to = requireString(request, "to");
        const result = incomeStatement(ledger, from, to);
        return {
          response: { ok: true, result: wireIncomeStatement(result) },
          nextState: state,
        };
      }
      case "verify": {
        const ledger = requireLedger(state);
        const asOf = requireString(request, "asOf");
        const failures = verifyLedger(ledger, asOf);
        return { response: { ok: true, result: { failures } }, nextState: state };
      }
      case "exit":
        return { response: { ok: true }, nextState: state };
      default:
        throw new BridgeError("UNKNOWN_OP", `unknown op: ${op}`);
    }
  } catch (error) {
    return { response: errorResponse(error), nextState: state };
  }
}
