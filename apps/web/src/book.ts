// SPDX-License-Identifier: AGPL-3.0-only
import {
  addMoney,
  type BookSnapshot,
  equalsMoney,
  formatMoney,
  isZeroMoney,
  type Money,
  money,
  multiplyMoney,
  negateMoney,
  newGuid,
  parseMoneyHalfUp,
  readBookSnapshot,
  type XmlAccount,
  type XmlCustomer,
  type XmlSplit,
  type XmlTransaction,
  type XmlVendor,
} from "@saldima/gnucash";
import {
  categoryKey,
  decodeImportRows,
  encodeImportRows,
  ImportFormatError,
  type ImportResult,
  type ImportRow,
  isLikelyDuplicate,
  parseImportFile,
  planImport,
  serializeCsv,
  serializeQif,
} from "@saldima/importers";
import { type Context, Hono } from "hono";
import {
  clearedSessionCookie,
  decryptTotpSecret,
  encryptTotpSecret,
  escapeHtml,
  hashPassword,
  isSameOrigin,
  MIN_PASSWORD_LENGTH,
  newSessionToken,
  newTotpSecret,
  readCookie,
  sessionCookie,
  sessionCookieName,
  sha256Hex,
  timingSafeStringEqual,
  totpUri,
  verifyPassword,
  verifyTotp,
} from "./auth.ts";
import { bookTotals, rolledUpTotals, sumSplitBalances } from "./balances.ts";
import { BookXmlStore } from "./book-xml-store.ts";
import {
  BOOK_COOKIE,
  BOOK_CURRENCIES,
  bookCookie,
  bookExportFilename,
  clearedBookCookie,
  DEFAULT_BOOK_ID,
  DEFAULT_BOOK_NAME,
  normaliseCurrency,
  resolveBookId,
} from "./books.ts";
import { deleteSession, deleteSetupToken } from "./data-access/auth-store.ts";
import { deleteBook } from "./data-access/books.ts";
import {
  deleteImportBatch,
  deleteStaleImportBatches,
  insertImportBatch,
  type StagedImport,
} from "./data-access/imports.ts";
import { designCss } from "./design.ts";
import type { R2BucketLike } from "./ports/cloudflare-r2.ts";
import { totpQrSvg } from "./qr.ts";
import { ReceiptStore } from "./receipt-store.ts";
import { balanceSheet, incomeStatement, trialBalance } from "./reports.ts";
import {
  ACCOUNT_TYPES,
  type AccountType,
  type BookTemplate,
  flattenTemplate,
  isTemplateId,
  TEMPLATE_IDS,
  templateById,
  templateLabel,
} from "./templates.ts";
import { epochMs, isoAfterSeconds, nowIso } from "./time/system-clock.ts";
import { VaultStore } from "./vault-store.ts";

/** GnuCash shows "Bank", not "BANK"; keep the wire format uppercase. */
function typeLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
}

// MARK: - Report period presets
//
// Pure calendar math on an already-known `YYYY-MM-DD` string (never `new
// Date`, which the lint gate reserves for clock adapters) so Reports can
// offer "This month/quarter/year" without reading wall-clock time itself.

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function monthRange(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return {
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
  };
}

function quarterRange(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    from: `${year}-${pad2(startMonth)}-01`,
    to: `${year}-${pad2(endMonth)}-${pad2(daysInMonth(year, endMonth))}`,
  };
}

function yearRange(today: string): { from: string; to: string } {
  const year = today.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export interface BookEnv {
  ENVIRONMENT?: string;
  SETUP_TOKEN?: string;
  PROVISION_SECRET?: string;
  MASTER_KEY?: string;
  R2: R2BucketLike;
}

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
}

interface SqlStorageLike {
  exec(query: string, ...bindings: Array<string | number | null>): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly id: { toString(): string };
  readonly storage: { readonly sql: SqlStorageLike };
}

type BookVariables = { tenantId: string; bookId: string };
type BookContext = Context<{ Bindings: BookEnv; Variables: BookVariables }>;
type BookApp = Hono<{ Bindings: BookEnv; Variables: BookVariables }>;

interface BookRow {
  id: string;
  name: string;
  template_id: string;
  currency: string;
  created_at: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  password_hash: string;
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  totp_verified: number;
  pending_totp: string | null;
}

interface CredentialRow {
  secret: string;
}

interface SetupTokenRow {
  token_hash: string;
  email: string;
  expires_at: string;
}

interface AccountRow {
  guid: string;
  name: string;
  account_type: string;
  parent_guid: string | null;
  code: string;
  hidden: boolean;
  placeholder: boolean;
}

interface AccountNode extends AccountRow {
  children: AccountNode[];
}

function toAccountRow(account: XmlAccount): AccountRow {
  return {
    guid: account.guid,
    name: account.name,
    account_type: account.type,
    parent_guid: account.parentGuid,
    code: account.code,
    hidden: account.hidden,
    placeholder: account.placeholder,
  };
}

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const IMPORT_TARGET_TYPES = new Set([
  "ASSET",
  "BANK",
  "CASH",
  "CREDIT",
  "LIABILITY",
  "RECEIVABLE",
  "PAYABLE",
]);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — Saldima</title>
<style>${designCss}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function formValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

export class Book {
  private readonly app: BookApp;
  private readonly store: BookXmlStore;
  private readonly receipts: ReceiptStore;
  private readonly vault: VaultStore;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: BookEnv,
  ) {
    this.migrate();
    this.store = new BookXmlStore(
      this.env.R2,
      this.state.id.toString(),
      this.env.MASTER_KEY ?? "",
    );
    this.receipts = new ReceiptStore(
      this.env.R2,
      this.state.id.toString(),
      this.env.MASTER_KEY ?? "",
    );
    this.vault = new VaultStore(this.env.R2, this.state.id.toString());
    this.app = this.buildApp();
  }

  private get sql(): SqlStorageLike {
    return this.state.storage.sql;
  }

  private rows<T>(query: string, ...bindings: Array<string | number | null>): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  private migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gcw_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gcw_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        totp_verified INTEGER NOT NULL DEFAULT 0,
        pending_totp TEXT,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gcw_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gcw_setup_tokens (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gcw_books (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gcw_import_batches (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        target_account_guid TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS import_batches_book_idx ON gcw_import_batches(book_id)",
    );
    this.sql.exec(
      `INSERT INTO gcw_books (id, name, template_id, currency, created_at)
       SELECT ?, ?, 'personal', 'USD', ?
       WHERE NOT EXISTS (SELECT 1 FROM gcw_books)`,
      DEFAULT_BOOK_ID,
      DEFAULT_BOOK_NAME,
      nowIso(),
    );
  }

  private buildApp(): BookApp {
    const app = new Hono<{ Bindings: BookEnv; Variables: BookVariables }>();
    app.use("*", async (c, next) => {
      c.set("tenantId", this.state.id.toString());
      c.set("bookId", this.currentBookId(c));
      await next();
    });

    app.onError((error, c) => {
      console.error(
        "book_error",
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof Error && error.stack) console.error(error.stack);
      return c.text("Internal Server Error", 500);
    });
    app.post("/internal/provision", (c) => this.internalProvision(c));
    app.get("/health", (c) =>
      c.json({
        ok: true,
        tenant: c.get("tenantId"),
        runtime: "durable-object",
      }),
    );
    app.get("/app", (c) => c.redirect("/app/books"));
    app.get("/app/login", (c) => this.loginPage(c));
    app.post("/app/login", (c) => this.login(c));
    app.post("/app/logout", (c) => this.logout(c));
    app.get("/app/setup", (c) => this.setupPage(c, "", c.req.query("token") ?? ""));
    app.post("/app/setup", (c) => this.setup(c));
    app.get("/app/settings", (c) => this.settingsPage(c));
    app.get("/app/settings/versions", (c) => this.versionsPage(c));
    app.post("/app/settings/versions/:id/restore", (c) => this.restoreVersion(c));
    app.get("/app/books", (c) => this.booksPage(c));
    app.post("/app/books", (c) => this.createBook(c));
    app.post("/app/books/:id/select", (c) => this.selectBook(c));
    app.post("/app/books/:id/rename", (c) => this.renameBook(c));
    app.post("/app/books/:id/delete", (c) => this.deleteBook(c));
    app.get("/app/accounts", (c) => this.accountsPage(c));
    app.get("/app/accounts/new", (c) => this.newAccountPage(c));
    app.post("/app/accounts", (c) => this.createAccount(c));
    app.get("/app/accounts/:guid/edit", (c) =>
      this.editAccountPage(c, c.req.param("guid") ?? ""),
    );
    app.post("/app/accounts/:guid", (c) => this.updateAccount(c));
    app.post("/app/accounts/:guid/delete", (c) => this.deleteAccount(c));
    app.get("/app/accounts/:guid/export/qif", (c) =>
      this.exportAccountQif(c, c.req.param("guid") ?? ""),
    );
    app.get("/app/accounts/:guid/export/csv", (c) =>
      this.exportAccountCsv(c, c.req.param("guid") ?? ""),
    );
    app.get("/app/accounts/:guid/reconcile", (c) =>
      this.reconcilePage(c, c.req.param("guid") ?? ""),
    );
    app.post("/app/accounts/:guid/reconcile", (c) => this.reconcileUpdate(c));
    app.get("/app/customers", (c) => this.customersPage(c));
    app.get("/app/customers/new", (c) => this.newCustomerPage(c));
    app.post("/app/customers", (c) => this.createCustomer(c));
    app.get("/app/customers/:guid/edit", (c) =>
      this.editCustomerPage(c, c.req.param("guid") ?? ""),
    );
    app.post("/app/customers/:guid", (c) => this.updateCustomer(c));
    app.post("/app/customers/:guid/delete", (c) => this.deleteCustomer(c));
    app.get("/app/invoices", (c) => this.invoicesPage(c));
    app.get("/app/invoices/new", (c) => this.newInvoicePage(c));
    app.post("/app/invoices", (c) => this.createInvoice(c));
    app.get("/app/invoices/:guid", (c) =>
      this.invoiceDetailPage(c, c.req.param("guid") ?? ""),
    );
    app.post("/app/invoices/:guid/lines", (c) => this.addInvoiceLine(c));
    app.post("/app/invoices/:guid/lines/:lineGuid/delete", (c) =>
      this.deleteInvoiceLine(c),
    );
    app.post("/app/invoices/:guid/post", (c) => this.postInvoice(c));
    app.post("/app/invoices/:guid/delete", (c) => this.deleteInvoiceDraft(c));
    app.get("/app/vendors", (c) => this.vendorsPage(c));
    app.get("/app/vendors/new", (c) => this.newVendorPage(c));
    app.post("/app/vendors", (c) => this.createVendor(c));
    app.get("/app/vendors/:guid/edit", (c) =>
      this.editVendorPage(c, c.req.param("guid") ?? ""),
    );
    app.post("/app/vendors/:guid", (c) => this.updateVendorRoute(c));
    app.post("/app/vendors/:guid/delete", (c) => this.deleteVendorRoute(c));
    app.get("/app/bills", (c) => this.billsPage(c));
    app.get("/app/bills/new", (c) => this.newBillPage(c));
    app.post("/app/bills", (c) => this.createBillRoute(c));
    app.get("/app/bills/:guid", (c) =>
      this.billDetailPage(c, c.req.param("guid") ?? ""),
    );
    app.post("/app/bills/:guid/lines", (c) => this.addBillLine(c));
    app.post("/app/bills/:guid/lines/:lineGuid/delete", (c) => this.deleteBillLine(c));
    app.post("/app/bills/:guid/post", (c) => this.postBillRoute(c));
    app.post("/app/bills/:guid/delete", (c) => this.deleteBillDraft(c));
    app.get("/app/receipts", (c) => this.receiptsPage(c));
    app.get("/app/receipts/new", (c) => this.newReceiptPage(c));
    app.post("/app/receipts", (c) => this.createReceiptExpense(c));
    app.get("/app/receipts/image/:txGuid", (c) => this.receiptImage(c));
    app.get("/app/export/xml", (c) => this.exportXml(c));
    app.get("/app/import", (c) => this.importPage(c));
    app.post("/app/import", (c) => this.importBook(c));
    app.get("/app/import/transactions", (c) => this.importTransactionsPage(c));
    app.post("/app/import/transactions", (c) => this.uploadTransactions(c));
    app.get("/app/import/transactions/:id", (c) => this.importMappingPage(c));
    app.post("/app/import/transactions/:id", (c) => this.commitTransactions(c));
    app.post("/app/import/transactions/:id/cancel", (c) =>
      this.cancelTransactionImport(c),
    );
    app.get("/app/reports", (c) => this.reportsPage(c));
    app.get("/app/vault/setup", (c) => this.vaultSetupPage(c));
    app.get("/app/vault/keys", (c) => this.vaultGetKeys(c));
    app.put("/app/vault/keys", (c) => this.vaultPutKeys(c));
    app.get("/app/vault/snapshots/:id", (c) => this.vaultGetSnapshot(c));
    app.put("/app/vault/snapshots/:id", (c) => this.vaultPutSnapshot(c));
    app.get("/app/vault/bundle-check", (c) => this.vaultBundleCheckPage(c));
    app.get("/app/help", (c) => this.helpPage(c));
    app.get("/app/journal", (c) => this.journalPage(c));
    app.get("/app/journal/new", (c) => this.newTransactionPage(c));
    app.post("/app/journal", (c) => this.createTransaction(c));
    app.post("/app/journal/:guid/void", (c) => this.voidTransactionRoute(c));
    app.post("/app/journal/:guid/unvoid", (c) => this.unvoidTransactionRoute(c));
    app.get("/app/security/totp", (c) => this.totpPage(c));
    app.post("/app/security/totp", (c) => this.totp(c));
    return app;
  }

  private userCount(): number {
    const rows = this.rows<{ count: number }>(
      "SELECT count(*) AS count FROM gcw_users",
    );
    return Number(rows[0]?.count ?? 0);
  }

  private userByEmail(email: string): UserRow | null {
    return (
      this.rows<UserRow>(
        "SELECT id, email, name, role, password_hash FROM gcw_users WHERE email = ? LIMIT 1",
        email.toLowerCase(),
      )[0] ?? null
    );
  }

  private userById(id: string): UserRow | null {
    return (
      this.rows<UserRow>(
        "SELECT id, email, name, role, password_hash FROM gcw_users WHERE id = ? LIMIT 1",
        id,
      )[0] ?? null
    );
  }

  private credential(userId: string): CredentialRow | null {
    return (
      this.rows<CredentialRow>(
        "SELECT secret FROM gcw_credentials WHERE user_id = ? AND kind = 'totp' LIMIT 1",
        userId,
      )[0] ?? null
    );
  }

  private async currentSession(c: BookContext): Promise<SessionRow | null> {
    const secure = new URL(c.req.url).protocol === "https:";
    const name = sessionCookieName(secure);
    const token = readCookie(c.req.header("cookie") ?? null, name);
    if (!token) return null;
    const hash = await sha256Hex(token);
    const row =
      this.rows<SessionRow>(
        `SELECT token_hash, user_id, expires_at, totp_verified, pending_totp
         FROM gcw_sessions WHERE token_hash = ? LIMIT 1`,
        hash,
      )[0] ?? null;
    if (!row) return null;
    if (row.expires_at <= nowIso()) {
      deleteSession(this.sql, hash);
      return null;
    }
    return row;
  }

  private async startSession(c: BookContext, userId: string): Promise<void> {
    const secure = new URL(c.req.url).protocol === "https:";
    const token = await newSessionToken();
    const hash = await sha256Hex(token);
    this.sql.exec(
      `INSERT INTO gcw_sessions
       (token_hash, user_id, expires_at, totp_verified, pending_totp, created_at)
       VALUES (?, ?, ?, 0, NULL, ?)`,
      hash,
      userId,
      isoAfterSeconds(SESSION_SECONDS),
      nowIso(),
    );
    c.header("Set-Cookie", sessionCookie(sessionCookieName(secure), token, secure));
  }

  private finishSession(tokenHash: string): void {
    this.sql.exec(
      "UPDATE gcw_sessions SET totp_verified = 1, pending_totp = NULL WHERE token_hash = ?",
      tokenHash,
    );
  }

  private async sessionTokenHash(c: BookContext): Promise<string | null> {
    const secure = new URL(c.req.url).protocol === "https:";
    const token = readCookie(c.req.header("cookie") ?? null, sessionCookieName(secure));
    return token ? sha256Hex(token) : null;
  }

  private loginPage(c: BookContext, error = "", email = ""): Response {
    return c.html(
      page(
        "Sign in",
        `<h1>Sign in</h1>
<p class="muted">Book ${escapeHtml(c.get("tenantId"))}</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/login">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>`,
      ),
      200,
    );
  }

  private async login(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const body = await c.req.parseBody();
    const email = formValue(body, "email").toLowerCase();
    const password = formValue(body, "password");
    const user = this.userByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return this.loginPage(c, "Email or password is incorrect.", email);
    }
    await this.startSession(c, user.id);
    return c.redirect("/app/security/totp");
  }

  private async internalProvision(c: BookContext): Promise<Response> {
    const secret = this.env.PROVISION_SECRET;
    if (!secret || c.req.header("authorization") !== `Bearer ${secret}`) {
      return c.text("Forbidden", 403);
    }
    const body = (await c.req.json()) as { email?: unknown };
    if (
      typeof body.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
    ) {
      return c.json({ error: "valid email required" }, 400);
    }
    const token = await newSessionToken();
    const hash = await sha256Hex(token);
    this.sql.exec(
      `INSERT INTO gcw_setup_tokens (token_hash, email, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
      hash,
      body.email.toLowerCase(),
      isoAfterSeconds(24 * 60 * 60),
      nowIso(),
    );
    return c.json({ token });
  }

  private async setupTokenFor(raw: string): Promise<SetupTokenRow | null> {
    if (!raw) return null;
    const hash = await sha256Hex(raw);
    const row =
      this.rows<SetupTokenRow>(
        `SELECT token_hash, email, expires_at FROM gcw_setup_tokens
         WHERE token_hash = ? LIMIT 1`,
        hash,
      )[0] ?? null;
    if (!row) return null;
    if (row.expires_at <= nowIso()) {
      deleteSetupToken(this.sql, hash);
      return null;
    }
    return row;
  }

  private async setupPage(
    c: BookContext,
    error = "",
    incomingToken = "",
  ): Promise<Response> {
    if (this.userCount() > 0) return c.text("Not found", 404);
    const record = await this.setupTokenFor(incomingToken);
    const allowed =
      record !== null ||
      Boolean(this.env.SETUP_TOKEN) ||
      this.env.ENVIRONMENT === "local";
    if (!allowed) return c.text("Not found", 404);
    const tokenField = record
      ? `<input type="hidden" name="token" value="${escapeHtml(incomingToken)}">`
      : this.env.SETUP_TOKEN
        ? `<label for="token">Setup token</label>
<input id="token" name="token" type="password" autocomplete="one-time-code" required>`
        : "";
    return c.html(
      page(
        "Set up",
        `<h1>Set up this book</h1>
<p class="muted">Create the owner account for ${escapeHtml(c.get("tenantId"))}.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/setup">
${tokenField}
<label for="template">Chart of accounts</label>
<select id="template" name="template">
${TEMPLATE_IDS.map((id) => `<option value="${id}">${escapeHtml(templateById(id).name)}</option>`).join("")}
</select>
<label for="name">Name</label>
<input id="name" name="name" type="text" autocomplete="name" required>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(record?.email ?? "")}"${record ? " readonly" : ""}>
<label for="password">Password (at least ${MIN_PASSWORD_LENGTH} characters)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
<button type="submit">Create owner</button>
</form>`,
      ),
      200,
    );
  }

  private async setup(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    if (this.userCount() > 0) return c.text("Not found", 404);
    const body = await c.req.parseBody();
    const rawToken = formValue(body, "token");
    const record = await this.setupTokenFor(rawToken);
    const envTokenOk =
      Boolean(this.env.SETUP_TOKEN) &&
      timingSafeStringEqual(rawToken, this.env.SETUP_TOKEN ?? "");
    if (!record && !envTokenOk && this.env.ENVIRONMENT !== "local") {
      return record
        ? this.setupPage(c, "The setup token is invalid.")
        : c.text("Not found", 404);
    }
    if (this.env.SETUP_TOKEN && !record && !envTokenOk) {
      return this.setupPage(c, "The setup token is incorrect.");
    }
    const name = formValue(body, "name");
    const email = (record?.email ?? formValue(body, "email")).toLowerCase();
    const password = formValue(body, "password");
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return this.setupPage(c, "Enter a name and a valid email address.");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return this.setupPage(
        c,
        `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`,
      );
    }
    const userId = newGuid();
    this.sql.exec(
      `INSERT INTO gcw_users (id, email, name, role, password_hash, created_at)
       VALUES (?, ?, ?, 'owner', ?, ?)`,
      userId,
      email,
      name,
      await hashPassword(password),
      nowIso(),
    );
    const template = templateById(formValue(body, "template"));
    const bookId = c.get("bookId");
    await this.seedAccounts(template, bookId);
    this.sql.exec(
      "UPDATE gcw_books SET template_id = ? WHERE id = ?",
      template.id,
      bookId,
    );
    if (record) deleteSetupToken(this.sql, record.token_hash);
    await this.startSession(c, userId);
    return c.redirect("/app/security/totp");
  }

  private async totpPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified === 1) return c.redirect("/app/books");
    if (!this.env.MASTER_KEY) return c.text("Server is not configured for TOTP.", 503);

    const credential = this.credential(session.user_id);
    let setupBlock = "";
    if (!credential) {
      let encrypted = session.pending_totp;
      let secret: string;
      if (encrypted) {
        secret = await decryptTotpSecret(
          this.env.MASTER_KEY,
          c.get("tenantId"),
          encrypted,
        );
      } else {
        secret = newTotpSecret();
        encrypted = await encryptTotpSecret(
          this.env.MASTER_KEY,
          c.get("tenantId"),
          secret,
        );
        this.sql.exec(
          "UPDATE gcw_sessions SET pending_totp = ? WHERE token_hash = ?",
          encrypted,
          session.token_hash,
        );
      }
      const user = this.userById(session.user_id);
      const uri = totpUri(secret, user?.email ?? "owner");
      setupBlock = `<p>Scan this with your authenticator app:</p>
<div class="qr" data-qr>${totpQrSvg(uri)}</div>
<details><summary>Can't scan? Show the secret</summary><code data-secret="${escapeHtml(secret)}">${escapeHtml(secret)}</code></details>
<p class="muted"><a href="${escapeHtml(uri)}">Open in authenticator</a></p>`;
    }

    return c.html(
      page(
        credential ? "Two-factor code" : "Set up two-factor",
        `<h1>${credential ? "Two-factor code" : "Set up two-factor"}</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${setupBlock}
<form method="post" action="/app/security/totp">
<label for="code">6-digit code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>
<button type="submit">${credential ? "Verify" : "Enable two-factor"}</button>
</form>`,
      ),
      200,
    );
  }

  private async totp(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified === 1) return c.redirect("/app/books");
    if (!this.env.MASTER_KEY) return c.text("Server is not configured for TOTP.", 503);

    const body = await c.req.parseBody();
    const code = formValue(body, "code");
    const credential = this.credential(session.user_id);
    let secret: string;
    if (credential) {
      secret = await decryptTotpSecret(
        this.env.MASTER_KEY,
        c.get("tenantId"),
        credential.secret,
      );
    } else {
      if (!session.pending_totp) return c.redirect("/app/security/totp");
      secret = await decryptTotpSecret(
        this.env.MASTER_KEY,
        c.get("tenantId"),
        session.pending_totp,
      );
    }

    if (!(await verifyTotp(secret, code, epochMs()))) {
      return this.totpPage(c, "That code is not valid. Try the next one.");
    }

    if (!credential) {
      this.sql.exec(
        `INSERT INTO gcw_credentials (id, user_id, kind, secret, created_at)
         VALUES (?, ?, 'totp', ?, ?)`,
        newGuid(),
        session.user_id,
        await encryptTotpSecret(this.env.MASTER_KEY, c.get("tenantId"), secret),
        nowIso(),
      );
    }
    this.finishSession(session.token_hash);
    return c.redirect("/app/books");
  }

  private bookRows(): BookRow[] {
    return this.rows<BookRow>(
      `SELECT id, name, template_id, currency, created_at
       FROM gcw_books ORDER BY created_at, id`,
    );
  }

  private bookById(id: string): BookRow | null {
    return (
      this.rows<BookRow>(
        `SELECT id, name, template_id, currency, created_at
         FROM gcw_books WHERE id = ? LIMIT 1`,
        id,
      )[0] ?? null
    );
  }

  private currentBookId(c: BookContext): string {
    const cookie = readCookie(c.req.header("cookie") ?? null, BOOK_COOKIE);
    return resolveBookId(
      cookie,
      this.bookRows().map((book) => book.id),
    );
  }

  private activeBook(c: BookContext): BookRow {
    const bookId = c.get("bookId");
    return (
      this.bookById(bookId) ?? {
        id: bookId,
        name: DEFAULT_BOOK_NAME,
        template_id: "personal",
        currency: "USD",
        created_at: "",
      }
    );
  }

  private bookCount(): number {
    const rows = this.rows<{ count: number }>(
      "SELECT count(*) AS count FROM gcw_books",
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async accountRows(bookId: string): Promise<AccountRow[]> {
    const document = await this.store.get(bookId);
    if (!document) return [];
    return document
      .accounts()
      .map(toAccountRow)
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
  }

  /** What the Accounts window shows: no structural ROOT and no template tree. */
  private async visibleAccountRows(bookId: string): Promise<AccountRow[]> {
    const rows = await this.accountRows(bookId);
    const excluded = new Set<string>();
    const templateRoot = rows.find(
      (row) =>
        row.account_type === "ROOT" &&
        row.name.trim().toLowerCase() === "template root",
    )?.guid;
    if (templateRoot) {
      const children = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.parent_guid) continue;
        const list = children.get(row.parent_guid) ?? [];
        list.push(row.guid);
        children.set(row.parent_guid, list);
      }
      const mark = (guid: string): void => {
        if (excluded.has(guid)) return;
        excluded.add(guid);
        for (const child of children.get(guid) ?? []) mark(child);
      };
      mark(templateRoot);
    }
    return rows.filter((row) => row.account_type !== "ROOT" && !excluded.has(row.guid));
  }

  private async splitRows(
    bookId: string,
  ): Promise<Array<{ accountGuid: string; value: Money; date: string }>> {
    const document = await this.store.get(bookId);
    if (!document) return [];
    return document.transactions().flatMap((transaction) =>
      transaction.splits.map((split) => ({
        accountGuid: split.accountGuid,
        value: split.value,
        date: transaction.datePosted,
      })),
    );
  }

  private async balanceMap(bookId: string): Promise<Map<string, Money>> {
    return sumSplitBalances(await this.splitRows(bookId));
  }

  /**
   * Bootstraps a brand-new book's live XML document (a fresh company or the
   * owner's first book) and creates its chart of accounts from a template.
   */
  private async seedAccounts(template: BookTemplate, bookId: string): Promise<void> {
    const currency = this.bookById(bookId)?.currency ?? "USD";
    const bookGuid = (await sha256Hex(`${this.state.id.toString()}:${bookId}`)).slice(
      0,
      32,
    );
    const document = await this.store.replace(
      bookId,
      {
        bookGuid,
        currencyCode: currency,
        fraction: 100,
        accounts: [],
        transactions: [],
      },
      nowIso(),
    );
    const root = document.accounts().find((account) => account.type === "ROOT");
    if (!root) throw new Error("bootstrap book has no root account");
    const commodity = { space: "CURRENCY", id: currency };
    const guids = new Map<string, string>();
    for (const row of flattenTemplate(template)) {
      const parentGuid = row.parentPath
        ? (guids.get(row.parentPath) ?? root.guid)
        : root.guid;
      const account = document.createAccount(
        {
          name: row.name,
          type: row.type,
          parentGuid,
          commodity,
          code: row.code ?? "",
          hidden: row.hidden,
          placeholder: row.placeholder,
        },
        newGuid(),
      );
      guids.set(row.path, account.guid);
    }
    await this.store.save(bookId, document, nowIso());
  }

  private async accountsTree(bookId: string): Promise<AccountNode[]> {
    const rows = await this.visibleAccountRows(bookId);
    const nodes = new Map<string, AccountNode>();
    for (const row of rows) nodes.set(row.guid, { ...row, children: [] });
    const roots: AccountNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.guid);
      if (!node) continue;
      const parent = row.parent_guid ? nodes.get(row.parent_guid) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sort = (list: AccountNode[]): void => {
      list.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const node of list) sort(node.children);
    };
    sort(roots);
    return roots;
  }

  private renderAccountTree(
    nodes: AccountNode[],
    depth = 0,
    balances: ReadonlyMap<string, Money> = new Map(),
  ): string {
    if (nodes.length === 0) return `<p class="muted">No accounts yet.</p>`;
    const items = nodes
      .map((node) => {
        const flags = [
          node.hidden ? "hidden" : "",
          node.placeholder ? "placeholder" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const balance = balances.get(node.guid);
        const amount = balance ? formatMoney(balance, 100n) : "0.00";
        const row = `<a href="/app/accounts/${escapeHtml(node.guid)}/edit"><strong>${escapeHtml(node.name)}</strong></a>
<span class="chip type-${escapeHtml(node.account_type.toLowerCase())}">${escapeHtml(typeLabel(node.account_type))}</span>${flags ? `<span class="muted">${flags}</span>` : ""}<span class="amount">${amount}</span>`;
        const open = `<li data-account-guid="${escapeHtml(node.guid)}" data-account-name="${escapeHtml(node.name)}">
${row}
${this.renderAccountTree(node.children, depth + 1, balances)}
</li>`;
        const folded = `<li data-account-guid="${escapeHtml(node.guid)}" data-account-name="${escapeHtml(node.name)}">
<details open><summary>${row}</summary>
${this.renderAccountTree(node.children, depth + 1, balances)}
</details>
</li>`;
        return node.children.length === 0 ? open : folded;
      })
      .join("");
    return `<ul class="accounts">${items}</ul>`;
  }

  private async accountOptions(
    bookId: string,
    exclude: ReadonlySet<string> = new Set(),
    selected = "",
  ): Promise<string> {
    const visit = (nodes: AccountNode[], depth: number): string =>
      nodes
        .map((node) => {
          if (exclude.has(node.guid)) return "";
          const label = `${"  ".repeat(depth)}${node.name} (${node.account_type})`;
          const chosen = node.guid === selected ? " selected" : "";
          return `<option value="${escapeHtml(node.guid)}"${chosen}>${escapeHtml(label)}</option>${visit(node.children, depth + 1)}`;
        })
        .join("");
    const tree = await this.accountsTree(bookId);
    return `<option value=""${selected === "" ? " selected" : ""}>No parent (top level)</option>${visit(tree, 0)}`;
  }

  private async accountByGuid(
    guid: string,
    bookId: string,
  ): Promise<AccountRow | null> {
    const document = await this.store.get(bookId);
    const account = document?.account(guid);
    return account ? toAccountRow(account) : null;
  }

  /** Structural roots and template accounts are never edited from the tree. */
  private async editableAccount(
    guid: string,
    bookId: string,
  ): Promise<AccountRow | null> {
    const account = await this.accountByGuid(guid, bookId);
    if (!account) return null;
    const visible = await this.visibleAccountRows(bookId);
    return visible.some((row) => row.guid === guid) ? account : null;
  }

  private async descendantGuids(guid: string, bookId: string): Promise<Set<string>> {
    const rows = await this.visibleAccountRows(bookId);
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parent_guid) {
        const list = children.get(row.parent_guid) ?? [];
        list.push(row.guid);
        children.set(row.parent_guid, list);
      }
    }
    const found = new Set<string>([guid]);
    const queue = [guid];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const child of children.get(current) ?? []) {
        if (found.has(child)) continue;
        found.add(child);
        queue.push(child);
      }
    }
    return found;
  }

  private async childCount(guid: string, bookId: string): Promise<number> {
    const rows = await this.accountRows(bookId);
    return rows.filter((row) => row.parent_guid === guid).length;
  }

  private async importAccounts(bookId: string): Promise<AccountRow[]> {
    const rows = await this.visibleAccountRows(bookId);
    return rows.filter((account) => !account.placeholder && !account.hidden);
  }

  private async importTargetAccounts(bookId: string): Promise<AccountRow[]> {
    const accounts = await this.importAccounts(bookId);
    return accounts.filter((account) => IMPORT_TARGET_TYPES.has(account.account_type));
  }

  /** Unmatched rows post to a visible "Imports" equity account. */
  private async ensureImportsAccount(bookId: string): Promise<string> {
    const document = await this.store.get(bookId);
    if (!document) throw new Error("book not found");
    const existing = document
      .accounts()
      .find((account) => account.name.trim().toLowerCase() === "imports");
    if (existing) {
      if (existing.hidden || existing.placeholder) {
        document.updateAccount(existing.guid, { hidden: false, placeholder: false });
        await this.store.save(bookId, document, nowIso());
      }
      return existing.guid;
    }
    const currency = this.bookById(bookId)?.currency ?? "USD";
    const created = document.createAccount(
      {
        name: "Imports",
        type: "EQUITY",
        parentGuid: null,
        commodity: { space: "CURRENCY", id: currency },
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return created.guid;
  }

  private stagedImport(id: string, bookId: string): StagedImport | null {
    const row =
      this.rows<{
        id: string;
        book_id: string;
        target_account_guid: string;
        source: string;
        payload: string;
        created_at: string;
      }>(
        `SELECT id, book_id, target_account_guid, source, payload, created_at
         FROM gcw_import_batches WHERE id = ? AND book_id = ? LIMIT 1`,
        id,
        bookId,
      )[0] ?? null;
    return row
      ? {
          id: row.id,
          bookId: row.book_id,
          targetAccountGuid: row.target_account_guid,
          source: row.source,
          payload: row.payload,
          createdAt: row.created_at,
        }
      : null;
  }

  private async splitHistory(
    bookId: string,
    accountGuid: string,
  ): Promise<Array<{ date: string; amount: Money }>> {
    const document = await this.store.get(bookId);
    if (!document) return [];
    return document.transactions().flatMap((transaction) =>
      transaction.splits
        .filter((split) => split.accountGuid === accountGuid)
        .map((split) => ({
          date: transaction.datePosted.slice(0, 10),
          amount: split.value,
        })),
    );
  }

  private importCategories(rows: readonly ImportRow[]): string[] {
    const categories = new Set<string>();
    for (const row of rows) {
      const main = categoryKey(row.category);
      if (main) categories.add(main);
      for (const split of row.splits) {
        const key = categoryKey(split.category);
        if (key) categories.add(key);
      }
    }
    return [...categories].sort((left, right) => left.localeCompare(right));
  }

  private accountOptionsFor(
    accounts: readonly AccountRow[],
    selected: string,
    exclude: string,
  ): string {
    return accounts
      .filter((account) => account.guid !== exclude)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}"${account.guid === selected ? " selected" : ""}>${escapeHtml(account.name)} (${escapeHtml(typeLabel(account.account_type))})</option>`,
      )
      .join("");
  }

  private async editAccountPage(
    c: BookContext,
    guid: string,
    error = "",
  ): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const account = await this.editableAccount(guid, bookId);
    if (!account) return c.text("Account not found", 404);
    const excluded = await this.descendantGuids(guid, bookId);
    const parentOptions = await this.accountOptions(
      bookId,
      excluded,
      account.parent_guid ?? "",
    );
    return c.html(
      this.appPage(
        "Edit account",
        `<h1>Edit account</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/accounts/${escapeHtml(guid)}">
<label for="name">Name</label>
<input id="name" name="name" type="text" required maxlength="200" value="${escapeHtml(account.name)}">
<label for="type">Type</label>
<select id="type" name="type">${ACCOUNT_TYPES.map((type) => `<option value="${type}"${type === account.account_type ? " selected" : ""}>${type}</option>`).join("")}</select>
<label for="parent">Parent</label>
<select id="parent" name="parent">${parentOptions}</select>
<label for="code">Code</label>
<input id="code" name="code" type="text" maxlength="40" value="${escapeHtml(account.code ?? "")}">
<label for="description">Description</label>
<textarea id="description" name="description" rows="3"></textarea>
<label><input type="checkbox" name="hidden"${account.hidden ? " checked" : ""}> Hidden</label>
<label><input type="checkbox" name="placeholder"${account.placeholder ? " checked" : ""}> Placeholder</label>
<button type="submit">Save account</button>
</form>
<form method="post" action="/app/accounts/${escapeHtml(guid)}/delete">
<button type="submit" class="danger">Delete account</button>
</form>
<p><a class="button secondary" href="/app/accounts/${escapeHtml(guid)}/reconcile">Reconcile</a></p>
<p>
<a href="/app/accounts/${escapeHtml(guid)}/export/qif">Export QIF</a>
&middot;
<a href="/app/accounts/${escapeHtml(guid)}/export/csv">Export CSV</a>
</p>
<p><a href="/app/accounts">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async updateAccount(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const account = guid ? await this.editableAccount(guid, bookId) : null;
    if (!account) return c.text("Account not found", 404);
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    const type = formValue(body, "type");
    const parent = formValue(body, "parent");
    if (!name || name.length > 200 || !ACCOUNT_TYPES.includes(type as AccountType)) {
      return this.editAccountPage(
        c,
        guid,
        "Enter a name and choose a valid account type.",
      );
    }
    if (parent) {
      const visible = await this.visibleAccountRows(bookId);
      const descendants = await this.descendantGuids(guid, bookId);
      if (!visible.some((row) => row.guid === parent) || descendants.has(parent)) {
        return this.editAccountPage(
          c,
          guid,
          "Choose a parent that is not this account or one of its children.",
        );
      }
    }
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    document.updateAccount(guid, {
      name,
      type,
      parentGuid: parent || null,
      code: formValue(body, "code") || "",
      description: formValue(body, "description") || "",
      hidden: body.hidden === "on",
      placeholder: body.placeholder === "on",
    });
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/accounts");
  }

  private async deleteAccount(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const account = guid ? await this.editableAccount(guid, bookId) : null;
    if (!account) return c.text("Account not found", 404);
    if ((await this.childCount(guid, bookId)) > 0) {
      return this.editAccountPage(
        c,
        guid,
        "Move or delete this account's children before deleting it.",
      );
    }
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    document.deleteAccount(guid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/accounts");
  }

  /** Splits for `guid` not yet reconciled, oldest first -- what Reconcile shows. */
  private async unreconciledSplits(
    bookId: string,
    guid: string,
  ): Promise<
    Array<{
      transactionGuid: string;
      date: string;
      description: string;
      split: XmlSplit;
    }>
  > {
    const document = await this.store.get(bookId);
    if (!document) return [];
    return document
      .transactions()
      .flatMap((transaction) =>
        transaction.splits
          .filter((split) => split.accountGuid === guid && split.reconcileState !== "y")
          .map((split) => ({
            transactionGuid: transaction.guid,
            date: transaction.datePosted,
            description: transaction.description,
            split,
          })),
      )
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  /**
   * GnuCash's Reconcile window: check off every transaction that appears on
   * a bank/card statement, see the cleared total update, and finish once it
   * matches the statement's ending balance. This is a manual, offline
   * workflow -- no bank feed or auto-matching, which stays out of scope.
   */
  private async reconcilePage(
    c: BookContext,
    guid: string,
    notice = "",
  ): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const account = await this.accountByGuid(guid, bookId);
    if (!account) return c.text("Account not found", 404);
    const rows = await this.unreconciledSplits(bookId, guid);
    const clearedTotal = rows
      .filter((row) => row.split.reconcileState === "c")
      .reduce((sum, row) => addMoney(sum, row.split.value), money(0n));
    const itemRows = rows
      .map(
        (row) =>
          `<li><label><input type="checkbox" name="cleared_${escapeHtml(row.split.guid)}"${row.split.reconcileState === "c" ? " checked" : ""}> ${escapeHtml(row.date.slice(0, 10))} &middot; ${escapeHtml(row.description)}</label><span class="amount">${formatMoney(row.split.value, 100n)}</span></li>`,
      )
      .join("");
    return c.html(
      this.appPage(
        `Reconcile ${account.name}`,
        `<h1>Reconcile ${escapeHtml(account.name)}</h1>
<p class="muted">Check off every transaction that appears on your statement. The cleared total must match the statement's ending balance before you can finish.</p>
${notice ? `<p class="error">${escapeHtml(notice)}</p>` : ""}
<form method="post" action="/app/accounts/${escapeHtml(guid)}/reconcile">
<label for="statement-date">Statement date</label>
<input id="statement-date" name="statement_date" type="date" value="${nowIso().slice(0, 10)}">
<label for="statement-balance">Statement ending balance</label>
<input id="statement-balance" name="statement_balance" inputmode="decimal" placeholder="1234.56">
<p class="muted">Cleared total so far: <strong>${formatMoney(clearedTotal, 100n)}</strong></p>
<ul class="journal">${itemRows || `<li><span class="muted">Nothing left to reconcile.</span></li>`}</ul>
<button type="submit" name="action" value="update">Update</button>
<button type="submit" name="action" value="finish">Finish reconciling</button>
</form>
<p><a href="/app/accounts/${escapeHtml(guid)}/edit">Back to account</a></p>`,
      ),
      200,
    );
  }

  private async reconcileUpdate(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const account = await this.accountByGuid(guid, bookId);
    if (!account) return c.text("Account not found", 404);
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const body = await c.req.parseBody();
    const action = formValue(body, "action");
    const statementDate = formValue(body, "statement_date");

    const rows = await this.unreconciledSplits(bookId, guid);
    let clearedTotal = money(0n);
    for (const row of rows) {
      const checked = body[`cleared_${row.split.guid}`] === "on";
      if (checked) clearedTotal = addMoney(clearedTotal, row.split.value);
      const newState = checked ? "c" : "n";
      if (newState !== row.split.reconcileState) {
        document.setSplitReconcileState(row.transactionGuid, row.split.guid, newState);
      }
    }

    if (action === "finish") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) {
        await this.store.save(bookId, document, nowIso());
        return this.reconcilePage(c, guid, "Enter a valid statement date to finish.");
      }
      let statementBalance: Money;
      try {
        statementBalance = parseMoneyHalfUp(formValue(body, "statement_balance"), 100n);
      } catch {
        await this.store.save(bookId, document, nowIso());
        return this.reconcilePage(c, guid, "Enter amounts like 1234.56 or -1234.56.");
      }
      if (!equalsMoney(clearedTotal, statementBalance)) {
        await this.store.save(bookId, document, nowIso());
        return this.reconcilePage(
          c,
          guid,
          `Not balanced yet: cleared total is ${formatMoney(clearedTotal, 100n)}, statement balance is ${formatMoney(statementBalance, 100n)}. Check off transactions until they match.`,
        );
      }
      const reconcileTimestamp = `${statementDate} 00:00:00 +0000`;
      for (const row of rows) {
        if (body[`cleared_${row.split.guid}`] === "on") {
          document.setSplitReconcileState(
            row.transactionGuid,
            row.split.guid,
            "y",
            reconcileTimestamp,
          );
        }
      }
      await this.store.save(bookId, document, nowIso());
      return c.redirect("/app/accounts");
    }

    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/accounts/${guid}/reconcile`);
  }

  private async accountsPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const book = this.activeBook(c);
    const balances = await this.balanceMap(bookId);
    const rows = await this.visibleAccountRows(bookId);
    const tree = await this.accountsTree(bookId);
    const totals = bookTotals(rows, balances);
    return c.html(
      this.appPage(
        "Accounts",
        `<h1>Accounts</h1>
<p class="muted">Company: <strong>${escapeHtml(book.name)}</strong> · Chart of accounts</p>
<div class="summary">
<div class="stat accent"><div class="label">Accounts</div><div class="value">${rows.length}</div></div>
<div class="stat green"><div class="label">Net assets</div><div class="value">${formatMoney(totals.netAssets, 100n)}</div></div>
<div class="stat blue"><div class="label">Profit</div><div class="value">${formatMoney(totals.profit, 100n)}</div></div>
</div>
<p>
<a class="button secondary" href="/app/books">Back</a>
<a class="button secondary" href="/app/accounts/new">Add account</a>
<a class="button secondary" href="/app/import">Import</a>
<a class="button secondary" href="/app/export/xml">Export</a>
</p>
${this.renderAccountTree(tree, 0, rolledUpTotals(rows, balances))}`,
      ),
      200,
    );
  }

  private async importPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    return c.html(
      this.appPage(
        "Import a book",
        `<h1>Import a GnuCash book</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<p class="muted">Accepts a .gnucash book in SQLite or gzip XML. Importing replaces the accounts and transactions in <strong>${escapeHtml(this.activeBook(c).name)}</strong> only.</p>
<form method="post" action="/app/import" enctype="multipart/form-data">
<label for="file">Book file</label>
<input id="file" name="file" type="file" required accept=".gnucash,.sqlite,application/gzip,application/xml">
<button type="submit">Import</button>
</form>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Bank transactions</h2>
<p class="muted">QIF, CSV and OFX/QFX statements are matched to your accounts with duplicate detection before anything is posted.</p>
<p><a class="cta" href="/app/import/transactions">Import transactions</a></p></div>
<p><a href="/app/accounts">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async importBook(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return this.importPage(c, "Choose a book file.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let snapshot: BookSnapshot;
    try {
      snapshot = await readBookSnapshot(bytes);
    } catch {
      return this.importPage(c, "That file is not a GnuCash SQLite or XML book.");
    }
    if (snapshot.accounts.length === 0) {
      return this.importPage(c, "The book has no accounts.");
    }
    const bookId = c.get("bookId");
    await this.store.replace(bookId, snapshot, nowIso());
    this.sql.exec("UPDATE gcw_books SET template_id = 'imported' WHERE id = ?", bookId);
    if (snapshot.currencyCode) {
      this.sql.exec(
        "UPDATE gcw_books SET currency = ? WHERE id = ?",
        snapshot.currencyCode,
        bookId,
      );
    }
    return c.redirect("/app/accounts");
  }

  private async importTransactionsPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const targets = await this.importTargetAccounts(bookId);
    return c.html(
      this.appPage(
        "Import transactions",
        `<h1>Import bank transactions</h1>
<p class="muted">QIF, CSV or OFX/QFX. Nothing is posted until you map the categories on the next screen.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${
  targets.length === 0
    ? `<p class="error">Add a bank, cash, card or other asset/liability account first.</p>
<p><a href="/app/accounts/new">Add account</a></p>`
    : `<form method="post" action="/app/import/transactions" enctype="multipart/form-data">
<label for="target">Statement account</label>
<select id="target" name="target" required>
${targets.map((account) => `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)} (${escapeHtml(typeLabel(account.account_type))})</option>`).join("")}
</select>
<label for="statement">Statement file</label>
<input id="statement" name="file" type="file" required accept=".qif,.csv,.ofx,.qfx,text/csv,application/x-ofx,application/vnd.intu.qfx">
<button type="submit">Continue to mapping</button>
</form>`
}
<p><a href="/app/import">Back to import</a></p>`,
      ),
      200,
    );
  }

  private async uploadTransactions(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const bookId = c.get("bookId");
    const targetGuid = formValue(body, "target");
    const target = targetGuid ? await this.accountByGuid(targetGuid, bookId) : null;
    if (
      !target ||
      target.placeholder ||
      target.hidden ||
      !IMPORT_TARGET_TYPES.has(target.account_type)
    ) {
      return this.importTransactionsPage(c, "Choose a valid statement account.");
    }
    const file = body.file;
    if (!(file instanceof File)) {
      return this.importTransactionsPage(c, "Choose a QIF, CSV or OFX file.");
    }
    if (file.size > MAX_IMPORT_BYTES) {
      return this.importTransactionsPage(c, "That file is larger than 10 MB.");
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      return this.importTransactionsPage(c, "That file could not be read as text.");
    }
    if (text.includes("\u0000")) {
      return this.importTransactionsPage(c, "That file is not a text statement.");
    }
    let parsed: ImportResult;
    try {
      parsed = parseImportFile(file.name, text);
    } catch (error) {
      if (error instanceof ImportFormatError) {
        return this.importTransactionsPage(c, error.message);
      }
      return this.importTransactionsPage(c, "That statement could not be read.");
    }
    const id = newGuid();
    const createdAt = nowIso();
    deleteStaleImportBatches(this.sql, bookId, isoAfterSeconds(-24 * 60 * 60));
    insertImportBatch(this.sql, {
      id,
      bookId,
      targetAccountGuid: target.guid,
      source: parsed.source,
      payload: encodeImportRows(parsed.rows),
      createdAt,
    });
    return c.redirect(`/app/import/transactions/${id}`);
  }

  private async importMappingPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const id = c.req.param("id") ?? "";
    const batch = id ? this.stagedImport(id, bookId) : null;
    if (!batch) return c.text("Import not found", 404);
    const target = await this.accountByGuid(batch.targetAccountGuid, bookId);
    if (!target) {
      deleteImportBatch(this.sql, batch.id, bookId);
      return c.text("The statement account no longer exists", 404);
    }
    let rows: ImportRow[];
    try {
      rows = decodeImportRows(batch.payload);
    } catch {
      deleteImportBatch(this.sql, batch.id, bookId);
      return c.text("That staged import is no longer readable", 404);
    }
    const history = await this.splitHistory(bookId, target.guid);
    const duplicates = rows.map((row) => isLikelyDuplicate(row, history));
    const duplicateCount = duplicates.filter(Boolean).length;
    const accounts = await this.importAccounts(bookId);
    const importsGuid = await this.ensureImportsAccount(bookId);
    if (!accounts.some((account) => account.guid === importsGuid)) {
      const imports = await this.accountByGuid(importsGuid, bookId);
      if (imports) accounts.push(imports);
    }
    const byName = new Map(
      accounts
        .filter((account) => account.guid !== target.guid)
        .map((account) => [account.name.trim().toLowerCase(), account.guid]),
    );
    const categories = this.importCategories(rows);
    const categoryRows = categories
      .map((key, index) => {
        const chosen = byName.get(key.toLowerCase()) ?? importsGuid;
        return `<tr><td>${escapeHtml(key)}</td><td><select name="category_${index}">${this.accountOptionsFor(accounts, chosen, target.guid)}</select></td></tr>`;
      })
      .join("");
    const preview = rows
      .slice(0, 200)
      .map(
        (row, index) =>
          `<li><span>${escapeHtml(row.date)} · ${escapeHtml(row.payee || row.memo || "Imported transaction")}${row.category ? ` <span class="muted">(${escapeHtml(row.category)})</span>` : ""}${duplicates[index] ? ' <span class="chip">Possible duplicate</span>' : ""}</span><span class="amount">${formatMoney(row.amount, 100n)}</span></li>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "Map transactions",
        `<h1>Map transactions</h1>
<p class="muted">${escapeHtml(batch.source.toUpperCase())} statement for <strong>${escapeHtml(target.name)}</strong> · ${rows.length} transaction${rows.length === 1 ? "" : "s"}${duplicateCount > 0 ? ` · <strong>${duplicateCount} possible duplicate${duplicateCount === 1 ? "" : "s"}</strong>` : ""}</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${
  categories.length > 0
    ? `<div class="card"><h2 style="margin-top:0">Categories</h2>
<table><thead><tr><th>Statement category</th><th>Account</th></tr></thead><tbody>${categoryRows}</tbody></table></div>`
    : `<p class="muted">This file has no categories; every row uses the account below.</p>`
}
<form method="post" action="/app/import/transactions/${escapeHtml(batch.id)}">
<h2>Default account</h2>
<p class="muted">Used for rows without a mapped category.</p>
<label for="default-account">Default account</label>
<select id="default-account" name="default_account" required>${this.accountOptionsFor(accounts, importsGuid, target.guid)}</select>
${
  duplicateCount > 0
    ? `<label><input type="checkbox" name="include_duplicates"> Import possible duplicates too</label>`
    : ""
}
<button type="submit">Import ${rows.length} transaction${rows.length === 1 ? "" : "s"}</button>
</form>
<form method="post" action="/app/import/transactions/${escapeHtml(batch.id)}/cancel"><button type="submit" class="secondary">Cancel</button></form>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Preview</h2>
<ul class="journal">${preview}</ul>${rows.length > 200 ? `<p class="muted">Showing the first 200 rows.</p>` : ""}</div>`,
      ),
      200,
    );
  }

  private async commitTransactions(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const id = c.req.param("id") ?? "";
    const batch = id ? this.stagedImport(id, bookId) : null;
    if (!batch) return c.text("Import not found", 404);
    const target = await this.accountByGuid(batch.targetAccountGuid, bookId);
    if (!target) {
      deleteImportBatch(this.sql, batch.id, bookId);
      return c.text("The statement account no longer exists", 404);
    }
    let rows: ImportRow[];
    try {
      rows = decodeImportRows(batch.payload);
    } catch {
      deleteImportBatch(this.sql, batch.id, bookId);
      return c.text("That staged import is no longer readable", 404);
    }
    const body = await c.req.parseBody();
    const defaultGuid = formValue(body, "default_account");
    const defaultAccount = defaultGuid
      ? await this.accountByGuid(defaultGuid, bookId)
      : null;
    if (
      !defaultAccount ||
      defaultAccount.placeholder ||
      defaultAccount.hidden ||
      defaultAccount.guid === target.guid
    ) {
      return this.importMappingPage(c, "Choose where unmatched rows should post.");
    }
    const importAccounts = await this.importAccounts(bookId);
    const accounts = new Set(importAccounts.map((row) => row.guid));
    const categoryAccounts: Record<string, string> = {};
    const categories = this.importCategories(rows);
    for (const [index, key] of categories.entries()) {
      const guid = formValue(body, `category_${index}`) || defaultAccount.guid;
      if (!accounts.has(guid) || guid === target.guid) {
        return this.importMappingPage(c, `Choose a valid account for ${key}.`);
      }
      categoryAccounts[key] = guid;
    }
    const history = await this.splitHistory(bookId, target.guid);
    const includeDuplicates = body.include_duplicates === "on";
    const selected = rows.filter(
      (row) => includeDuplicates || !isLikelyDuplicate(row, history),
    );
    if (selected.length === 0) {
      return this.importMappingPage(
        c,
        "Every row looks like a duplicate. Tick the box to import them anyway.",
      );
    }
    const planned = planImport(selected, {
      targetAccountGuid: target.guid,
      defaultAccountGuid: defaultAccount.guid,
      categoryAccounts,
    });
    const visibleRows = await this.visibleAccountRows(bookId);
    const knownAccounts = new Set(visibleRows.map((row) => row.guid));
    for (const transaction of planned) {
      let total = money(0n);
      for (const split of transaction.splits) {
        if (!knownAccounts.has(split.accountGuid)) {
          return this.importMappingPage(c, "A mapped account no longer exists.");
        }
        total = addMoney(total, split.value);
      }
      if (transaction.splits.length < 2 || !isZeroMoney(total)) {
        return this.importMappingPage(c, "That statement could not be balanced.");
      }
    }
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const currency = this.bookById(bookId)?.currency ?? "USD";
    for (const transaction of planned) {
      document.postTransaction(
        {
          currency: { space: "CURRENCY", id: currency },
          datePosted: `${transaction.date} 00:00:00 +0000`,
          dateEntered: `${transaction.date} 00:00:00 +0000`,
          description: transaction.description,
          splits: transaction.splits.map((split) => ({
            accountGuid: split.accountGuid,
            value: split.value,
          })),
        },
        {
          transaction: newGuid(),
          splits: transaction.splits.map(() => newGuid()),
        },
      );
    }
    await this.store.save(bookId, document, nowIso());
    deleteImportBatch(this.sql, batch.id, bookId);
    return c.redirect("/app/journal");
  }

  private async cancelTransactionImport(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const id = c.req.param("id") ?? "";
    if (id) deleteImportBatch(this.sql, id, c.get("bookId"));
    return c.redirect("/app/import/transactions");
  }

  /**
   * The live document is already real GnuCash XML (the same shape desktop
   * GnuCash writes), so export is just handing over its current bytes --
   * no snapshot rebuild needed.
   */
  private async exportXml(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const book = this.activeBook(c);
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const gzipped = await new Response(
      new Blob([new TextEncoder().encode(document.serialize())])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return new Response(gzipped, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${bookExportFilename(book.name)}"`,
      },
    });
  }

  /**
   * One account's register as `parseQif`/`parseCsv` rows: the other side of
   * a two-split transaction becomes the QIF/CSV "category", matching how
   * desktop GnuCash's own QIF export treats a simple transfer.
   */
  private registerExportRows(
    document: { accounts(): XmlAccount[]; transactions(): XmlTransaction[] },
    accountGuid: string,
  ): ImportRow[] {
    const names = new Map(
      document.accounts().map((account) => [account.guid, account.name]),
    );
    const rows: ImportRow[] = [];
    for (const transaction of document.transactions()) {
      const mine = transaction.splits.filter(
        (split) => split.accountGuid === accountGuid,
      );
      if (mine.length === 0) continue;
      const others = transaction.splits.filter(
        (split) => split.accountGuid !== accountGuid,
      );
      const firstOther = others[0];
      const category =
        others.length === 1 && firstOther
          ? (names.get(firstOther.accountGuid) ?? "")
          : "Split Transaction";
      for (const split of mine) {
        rows.push({
          date: transaction.datePosted.slice(0, 10),
          amount: split.value,
          payee: transaction.description,
          memo: split.memo,
          reference: transaction.num,
          category,
          splits: [],
        });
      }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }

  private registerExportFilename(accountName: string, extension: string): string {
    const safe = accountName
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${safe || "account"}.${extension}`;
  }

  private async exportAccountQif(c: BookContext, guid: string): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const account = document?.account(guid);
    if (!document || !account) return c.text("Account not found", 404);
    const body = serializeQif(this.registerExportRows(document, guid));
    return new Response(body, {
      headers: {
        "content-type": "text/qif",
        "content-disposition": `attachment; filename="${this.registerExportFilename(account.name, "qif")}"`,
      },
    });
  }

  private async exportAccountCsv(c: BookContext, guid: string): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const account = document?.account(guid);
    if (!document || !account) return c.text("Account not found", 404);
    const body = serializeCsv(this.registerExportRows(document, guid));
    return new Response(body, {
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="${this.registerExportFilename(account.name, "csv")}"`,
      },
    });
  }

  private async reportsPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const visible = await this.visibleAccountRows(bookId);
    const accounts = visible.map((row) => ({
      guid: row.guid,
      name: row.name,
      account_type: row.account_type,
    }));
    const splits = await this.splitRows(bookId);

    const today = nowIso().slice(0, 10);
    const asOf = (c.req.query("as_of") ?? today).trim();
    const fromRaw = (c.req.query("from") ?? "").trim();
    const toRaw = (c.req.query("to") ?? "").trim();
    const period = { ...(fromRaw && { from: fromRaw }), ...(toRaw && { to: toRaw }) };

    const trial = trialBalance(accounts, splits, asOf || undefined);
    const sheet = balanceSheet(accounts, splits, asOf || undefined);
    const pnl = incomeStatement(accounts, splits, period);
    const trialRows = trial.rows
      .map(
        (row) =>
          `<li><span>${escapeHtml(row.name)} <span class="chip type-${escapeHtml(row.type.toLowerCase())}">${escapeHtml(typeLabel(row.type))}</span></span><span class="amount">${formatMoney(row.debit.num === 0n ? row.credit : row.debit, 100n)}</span></li>`,
      )
      .join("");
    const presetLink = (
      label: string,
      range: { from: string; to: string } | null,
    ): string => {
      const query = range
        ? `?as_of=${encodeURIComponent(asOf)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
        : `?as_of=${encodeURIComponent(asOf)}&from=&to=`;
      const active =
        range === null
          ? !fromRaw && !toRaw
          : range.from === fromRaw && range.to === toRaw;
      return `<a class="button secondary${active ? " active" : ""}" href="/app/reports${query}">${escapeHtml(label)}</a>`;
    };
    return c.html(
      this.appPage(
        "Reports",
        `<h1>Reports</h1>
<p class="muted">Same reports and kernel as the apps. Amounts are half-even for display.</p>
<form method="get" action="/app/reports" class="card">
<h2 style="margin-top:0">Period</h2>
<label for="as_of">Balance sheet &amp; trial balance, as of</label>
<input id="as_of" name="as_of" type="date" value="${escapeHtml(asOf)}">
<label for="from">Profit &amp; loss, from</label>
<input id="from" name="from" type="date" value="${escapeHtml(fromRaw)}">
<label for="to">to</label>
<input id="to" name="to" type="date" value="${escapeHtml(toRaw)}">
<button type="submit">Apply</button>
<p class="muted" style="margin-top:0.75rem">
${presetLink("This month", monthRange(today))}
${presetLink("This quarter", quarterRange(today))}
${presetLink("This year", yearRange(today))}
${presetLink("All time", null)}
</p>
</form>
<div class="summary">
<div class="stat accent"><div class="label">Net assets</div><div class="value">${formatMoney(sheet.assets, 100n)}</div></div>
<div class="stat green"><div class="label">Profit</div><div class="value">${formatMoney(pnl.netIncome, 100n)}</div></div>
<div class="stat blue"><div class="label">Trial balance</div><div class="value">${trial.balanced ? "Balanced" : "Out"}</div></div>
</div>
<div class="card"><h2 style="margin-top:0">Trial balance</h2><p class="muted" style="margin-top:-0.5rem">as of ${escapeHtml(asOf)}</p><ul class="journal">${trialRows || `<li><span class="muted">No postings yet.</span></li>`}</ul></div>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Balance sheet</h2>
<p class="muted" style="margin-top:-0.5rem">as of ${escapeHtml(asOf)}</p>
<ul class="journal">
<li><span>Assets</span><span class="amount">${formatMoney(sheet.assets, 100n)}</span></li>
<li><span>Liabilities</span><span class="amount">${formatMoney(sheet.liabilities, 100n)}</span></li>
<li><span>Equity</span><span class="amount">${formatMoney(addMoney(sheet.equity, sheet.retainedEarnings), 100n)}</span></li>
</ul></div>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Profit &amp; loss</h2>
<p class="muted" style="margin-top:-0.5rem">${fromRaw || toRaw ? `${escapeHtml(fromRaw || "the start")} to ${escapeHtml(toRaw || "now")}` : "all time"}</p>
<ul class="journal">
<li><span>Revenue</span><span class="amount">${formatMoney(pnl.revenue, 100n)}</span></li>
<li><span>Expenses</span><span class="amount">${formatMoney(pnl.expenses, 100n)}</span></li>
<li><span><strong>Net income</strong></span><span class="amount"><strong>${formatMoney(pnl.netIncome, 100n)}</strong></span></li>
</ul></div>`,
      ),
      200,
    );
  }

  private async helpPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const topics: Array<[string, string]> = [
      [
        "Getting started",
        "Create a book from a template, pick the currency and add your first bank account. Everything is stored in a file you own.",
      ],
      [
        "Accounts",
        "The chart of accounts is a tree. Fold branches with the triangles; placeholder accounts group children and cannot receive postings.",
      ],
      [
        "Journal and register",
        "Post a balanced entry from the Journal. Every split keeps an exact fraction, and the accounts update immediately.",
      ],
      [
        "Importing a bank statement",
        "Upload a QIF, CSV or OFX/QFX file against the bank or card account it belongs to. Map statement categories to accounts, then post. Rows matching an existing posting on the same account, amount and a date within three days are marked as possible duplicates and skipped unless you include them.",
      ],
      [
        "Reports",
        "Trial balance, balance sheet and profit and loss all read the same posted splits. Change the date range when reports gain options.",
      ],
      [
        "Compatible with GnuCash",
        "SQLite and gzip XML books use the desktop schema. Amounts are rationals; posting normalises half-up and display rounds half-even.",
      ],
      [
        "Settings and security",
        "Two-factor authentication protects the hosted book. Preferences and appearance live in Settings.",
      ],
    ];
    return c.html(
      this.appPage(
        "Help",
        `<h1>Help</h1>
<p class="muted">The same chapter structure as the desktop manual, written for this app.</p>
${topics.map(([title, body]) => `<div class="card" style="margin-bottom:1rem"><h2 style="margin-top:0">${escapeHtml(title)}</h2><p class="muted">${escapeHtml(body)}</p></div>`).join("")}`,
      ),
      200,
    );
  }

  private async journalPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const accounts = new Map(
      (document?.accounts() ?? []).map((row) => [row.guid, row.name]),
    );
    const query = (c.req.query("q") ?? "").trim();
    const needle = query.toLowerCase();
    const matches = (tx: XmlTransaction): boolean =>
      needle === "" ||
      tx.description.toLowerCase().includes(needle) ||
      tx.splits.some((split) => split.memo.toLowerCase().includes(needle)) ||
      tx.splits.some((split) =>
        (accounts.get(split.accountGuid) ?? "").toLowerCase().includes(needle),
      );
    const txs = (document?.transactions() ?? [])
      .filter(matches)
      .sort((left, right) =>
        left.datePosted === right.datePosted
          ? left.guid.localeCompare(right.guid)
          : right.datePosted.localeCompare(left.datePosted),
      );
    const items = txs
      .slice(0, 200)
      .map((tx) => {
        const rows = tx.splits
          .map(
            (split) =>
              `<li><span>${escapeHtml(accounts.get(split.accountGuid) ?? "?")}</span><span class="amount">${formatMoney(split.value, 100n)}</span></li>`,
          )
          .join("");
        const voidControls = tx.voided
          ? `<p class="muted">Voided: ${escapeHtml(tx.voidReason ?? "")} (${escapeHtml(tx.voidTime?.slice(0, 10) ?? "")})</p>
<form method="post" action="/app/journal/${escapeHtml(tx.guid)}/unvoid"><button type="submit" class="secondary">Unvoid</button></form>`
          : `<form method="post" action="/app/journal/${escapeHtml(tx.guid)}/void">
<label for="void-reason-${escapeHtml(tx.guid)}">Void reason</label>
<input id="void-reason-${escapeHtml(tx.guid)}" name="reason" type="text" required maxlength="200">
<button type="submit" class="secondary">Void</button>
</form>`;
        return `<div class="card" style="margin-bottom:1rem"><h2 style="margin:0">${escapeHtml(tx.description)}${tx.voided ? ` <span class="chip">VOID</span>` : ""}</h2><p class="muted">${escapeHtml(tx.datePosted.slice(0, 10))}</p><ul class="journal">${rows}</ul>${voidControls}</div>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "General Journal",
        `<h1>General Journal</h1>
<p class="muted">Every transaction in this book, like Tools → General Journal.</p>
<p><a href="/app/journal/new" class="cta">New transaction</a></p>
<form method="get" action="/app/journal" class="card" style="margin-bottom:1rem">
<label for="journal-search">Find transactions</label>
<input id="journal-search" name="q" type="text" placeholder="Description, memo or account" value="${escapeHtml(query)}">
<button type="submit" class="secondary">Search</button>
${query ? `<a href="/app/journal">Clear</a>` : ""}
</form>
${query ? `<p class="muted">${txs.length} match${txs.length === 1 ? "" : "es"} for "${escapeHtml(query)}".</p>` : ""}
${items || `<p class="muted">${query ? "No matching transactions." : "No transactions yet."}</p>`}${txs.length > 200 ? `<p class="muted">Showing the most recent 200 of ${txs.length} transactions.</p>` : ""}`,
      ),
      200,
    );
  }

  // Two legs are required (a simple payment); up to four more are optional,
  // so a transaction with tax or fee splits (e.g. expense + input tax +
  // payable) can be entered directly instead of needing a bulk import.
  private static readonly SPLIT_ROWS = 6;

  private async newTransactionPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const visible = await this.visibleAccountRows(c.get("bookId"));
    const options = visible
      .filter((row) => !row.placeholder && !row.hidden)
      .map(
        (row) =>
          `<option value="${escapeHtml(row.guid)}">${escapeHtml(row.name)}</option>`,
      )
      .join("");
    const rows = Array.from(
      { length: Book.SPLIT_ROWS },
      (_, index) => `<label for="split-account-${index}">${
        index < 2 ? "Account" : "Account (optional)"
      }</label>
<select id="split-account-${index}" name="split-account-${index}"${index < 2 ? " required" : ""}>
<option value=""></option>
${options}
</select>
<label for="split-amount-${index}">Amount${index >= 2 ? " (optional)" : ""}</label>
<input id="split-amount-${index}" name="split-amount-${index}" inputmode="decimal"${index < 2 ? " required" : ""} placeholder="12.34 or -12.34">`,
    ).join("\n");
    return c.html(
      this.appPage(
        "New transaction",
        `<h1>New transaction</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<p class="muted">Each split takes a signed amount; the splits used must sum to zero. Leave an optional split blank to skip it.</p>
<form method="post" action="/app/journal">
<label for="date">Date</label>
<input id="date" name="date" type="date" required value="${nowIso().slice(0, 10)}">
<label for="description">Description</label>
<input id="description" name="description" type="text" required maxlength="200">
${rows}
<button type="submit">Post transaction</button>
</form>
<p><a href="/app/journal">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async createTransaction(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const date = formValue(body, "date");
    const description = formValue(body, "description");
    const bookId = c.get("bookId");
    const visibleRows = await this.visibleAccountRows(bookId);
    const accounts = new Set(visibleRows.map((row) => row.guid));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return this.newTransactionPage(c, "Enter a valid date.");
    }
    if (!description || description.length > 200) {
      return this.newTransactionPage(c, "Enter a description.");
    }

    const splits: Array<{ account: string; value: Money }> = [];
    for (let index = 0; index < Book.SPLIT_ROWS; index += 1) {
      const account = formValue(body, `split-account-${index}`);
      const amountText = formValue(body, `split-amount-${index}`);
      if (!account && !amountText) continue;
      if (!accounts.has(account)) {
        return this.newTransactionPage(
          c,
          "Choose a valid account for every split used.",
        );
      }
      let value: Money;
      try {
        value = parseMoneyHalfUp(amountText, 100n);
      } catch {
        return this.newTransactionPage(c, "Enter amounts like 12.34 or -12.34.");
      }
      if (equalsMoney(value, money(0n))) {
        return this.newTransactionPage(c, "A split's amount must not be zero.");
      }
      splits.push({ account, value });
    }
    if (splits.length < 2) {
      return this.newTransactionPage(c, "Use at least two splits.");
    }
    const total = splits.reduce((sum, split) => addMoney(sum, split.value), money(0n));
    if (!equalsMoney(total, money(0n))) {
      return this.newTransactionPage(c, "The splits must sum to zero.");
    }

    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const currency = this.bookById(bookId)?.currency ?? "USD";
    document.postTransaction(
      {
        currency: { space: "CURRENCY", id: currency },
        datePosted: `${date} 00:00:00 +0000`,
        dateEntered: `${date} 00:00:00 +0000`,
        description,
        splits: splits.map((split) => ({
          accountGuid: split.account,
          value: split.value,
        })),
      },
      {
        transaction: newGuid(),
        splits: splits.map(() => newGuid()),
      },
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/journal");
  }

  /**
   * Voids a transaction (GnuCash's "Void Transaction", not a delete): the
   * original splits are preserved for audit but zeroed, so the
   * transaction stops affecting any balance. Silently no-ops on an
   * unknown transaction, a blank reason, or a transaction that's already
   * voided -- the journal page's own markup already prevents all three
   * from the UI, so this is just a safety net, not a place for elaborate
   * error reporting.
   */
  private async voidTransactionRoute(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (document) {
      const body = await c.req.parseBody();
      const reason = formValue(body, "reason");
      try {
        document.voidTransaction(c.req.param("guid") ?? "", reason, nowIso());
        await this.store.save(bookId, document, nowIso());
      } catch {
        // Unknown transaction, blank reason, or already voided -- nothing to do.
      }
    }
    return c.redirect("/app/journal");
  }

  private async unvoidTransactionRoute(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (document) {
      try {
        document.unvoidTransaction(c.req.param("guid") ?? "");
        await this.store.save(bookId, document, nowIso());
      } catch {
        // Unknown transaction, or it isn't voided -- nothing to do.
      }
    }
    return c.redirect("/app/journal");
  }

  private async newAccountPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const parentOptions = await this.accountOptions(c.get("bookId"));
    return c.html(
      this.appPage(
        "Add account",
        `<h1>Add account</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/accounts">
<label for="name">Name</label>
<input id="name" name="name" type="text" required maxlength="200">
<label for="type">Type</label>
<select id="type" name="type">${ACCOUNT_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("")}</select>
<label for="parent">Parent</label>
<select id="parent" name="parent">${parentOptions}</select>
<button type="submit">Add account</button>
</form>
<p><a href="/app/accounts">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async createAccount(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    const type = formValue(body, "type");
    const parent = formValue(body, "parent");
    const bookId = c.get("bookId");
    if (!name || name.length > 200 || !ACCOUNT_TYPES.includes(type as AccountType)) {
      return this.newAccountPage(c, "Enter a name and choose a valid account type.");
    }
    const visible = await this.visibleAccountRows(bookId);
    if (parent && !visible.some((row) => row.guid === parent)) {
      return this.newAccountPage(c, "The selected parent no longer exists.");
    }
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const currency = this.bookById(bookId)?.currency ?? "USD";
    document.createAccount(
      {
        name,
        type,
        parentGuid: parent || null,
        commodity: { space: "CURRENCY", id: currency },
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/accounts");
  }

  private appPage(title: string, body: string): string {
    return page(
      title,
      `<header class="appbar">
<a class="brand" href="/app/books">Saldima</a>
<nav><a href="/app/accounts">Accounts</a><a href="/app/journal">Journal</a><a href="/app/invoices">Invoices</a><a href="/app/bills">Bills</a><a href="/app/receipts">Receipts</a><a href="/app/reports">Reports</a><a href="/app/vault/setup">Vault</a><a href="/app/books">Books</a><a href="/app/help">Help</a><a href="/app/settings">Settings</a></nav>
</header>
${body}
<footer class="appfoot"><a href="https://github.com/johnarleyburns/saldima">Source code</a> · AGPL-3.0-only</footer>`,
    );
  }

  private async booksPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const activeId = c.get("bookId");
    const books = this.bookRows();
    const rows = books
      .map((book) => {
        const active = book.id === activeId;
        return `<li class="card" style="margin-bottom:1rem" data-book-id="${escapeHtml(book.id)}">
<strong>${escapeHtml(book.name)}</strong>${active ? ` <span class="chip">Active</span>` : ""}
<p class="muted">${escapeHtml(templateLabel(book.template_id))} · ${escapeHtml(book.currency)} · created ${escapeHtml(book.created_at.slice(0, 10))}</p>
<form method="post" action="/app/books/${escapeHtml(book.id)}/select"><button type="submit" class="secondary">Select</button></form>
<form method="post" action="/app/books/${escapeHtml(book.id)}/delete"><button type="submit" class="danger">Delete</button></form>
</li>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "Books",
        `<h1>Books</h1>
<p class="muted">Each book is one company, like a GnuCash file. Importing or exporting touches only the active company.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<ul style="list-style:none;padding:0">${rows}</ul>
<div class="card">
<h2 style="margin-top:0">New company</h2>
<form method="post" action="/app/books">
<label for="book-name">Company name</label>
<input id="book-name" name="name" type="text" required maxlength="200">
<label for="book-template">Chart of accounts</label>
<select id="book-template" name="template">
${TEMPLATE_IDS.map((id) => `<option value="${id}">${escapeHtml(templateById(id).name)}</option>`).join("")}
</select>
<label for="book-currency">Currency</label>
<select id="book-currency" name="currency">
${BOOK_CURRENCIES.map((code) => `<option value="${code}">${code}</option>`).join("")}
</select>
<button type="submit">Create company</button>
</form>
</div>`,
      ),
      200,
    );
  }

  private async createBook(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    const template = formValue(body, "template");
    const currency = normaliseCurrency(formValue(body, "currency"));
    if (!name || name.length > 200) {
      return this.booksPage(c, "Enter a company name.");
    }
    if (!isTemplateId(template)) {
      return this.booksPage(c, "Choose a chart of accounts.");
    }
    if (!currency) {
      return this.booksPage(c, "Choose a three-letter currency.");
    }
    const id = newGuid();
    this.sql.exec(
      `INSERT INTO gcw_books (id, name, template_id, currency, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      name,
      template,
      currency,
      nowIso(),
    );
    await this.seedAccounts(templateById(template), id);
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", bookCookie(id, secure));
    return c.redirect("/app/accounts");
  }

  private async selectBook(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const id = c.req.param("id") ?? "";
    if (!id || !this.bookById(id)) return c.text("Company not found", 404);
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", bookCookie(id, secure));
    return c.redirect("/app/accounts");
  }

  private async renameBook(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const id = c.req.param("id") ?? "";
    if (!id || !this.bookById(id)) return c.text("Company not found", 404);
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    if (!name || name.length > 200) {
      return this.booksPage(c, "Enter a company name.");
    }
    this.sql.exec("UPDATE gcw_books SET name = ? WHERE id = ?", name, id);
    return c.redirect("/app/settings");
  }

  private async deleteBook(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const id = c.req.param("id") ?? "";
    if (!id || !this.bookById(id)) return c.text("Company not found", 404);
    if (this.bookCount() <= 1) {
      return c.text("Keep at least one company.", 409);
    }
    await this.store.delete(id);
    deleteBook(this.sql, id);
    if (c.get("bookId") === id) {
      const secure = new URL(c.req.url).protocol === "https:";
      c.header("Set-Cookie", clearedBookCookie(secure));
    }
    return c.redirect("/app/books");
  }

  private async settingsPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const user = this.userById(session.user_id);
    if (!user) return c.redirect("/app/login");
    const book = this.activeBook(c);
    return c.html(
      this.appPage(
        "Settings",
        `<h1>Settings</h1>
<p class="muted">Book ${escapeHtml(c.get("tenantId"))}</p>
<p>Signed in as <strong>${escapeHtml(user.email)}</strong> (${escapeHtml(user.role)}).</p>
<p>Active company: <strong>${escapeHtml(book.name)}</strong> · ${escapeHtml(templateLabel(book.template_id))} · ${escapeHtml(book.currency)}</p>
<form method="post" action="/app/books/${escapeHtml(book.id)}/rename">
<label for="book-name">Rename company</label>
<input id="book-name" name="name" type="text" required maxlength="200" value="${escapeHtml(book.name)}">
<button type="submit" class="secondary">Rename company</button>
</form>
<p><a href="/app/settings/versions">Backups and version history</a></p>
<p>Two-factor authentication is enabled.</p>
<form method="post" action="/app/logout"><button type="submit">Sign out</button></form>`,
      ),
      200,
    );
  }

  /**
   * Zero-knowledge vault, Milestone 1 (issue #88): the page itself is
   * just a mount point (`#vault-app`) -- `apps/web/src/client/vault.ts`
   * builds the actual setup/backup/verify UI and does every crypto
   * operation in the browser. This handler never sees a passphrase, a
   * recovery code, or a key.
   */
  private async vaultSetupPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    return c.html(
      this.appPage(
        "Vault",
        `<h1>Zero-knowledge vault</h1>
<p class="muted">Encrypts a backup of this book entirely in your browser. Saldima never sees your passphrase, your key, or your recovery code. If you lose both your passphrase and your recovery code, this backup cannot be recovered -- by design.</p>
<div id="vault-app" data-book-id="${escapeHtml(bookId)}">Loading…</div>
<script type="module" src="/vault.js"></script>`,
      ),
      200,
    );
  }

  /**
   * Opaque storage for the wrapped-DEK key envelope -- never read or
   * written by anything but the client bundle. See `vault-store.ts`.
   */
  private async vaultGetKeys(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (session?.totp_verified !== 1) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const json = await this.vault.loadKeyEnvelope(c.get("bookId"));
    if (!json) return c.json({ error: "not_found" }, 404);
    return c.text(json, 200, { "content-type": "application/json" });
  }

  private async vaultPutKeys(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (session?.totp_verified !== 1) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    await this.vault.saveKeyEnvelope(c.get("bookId"), new TextDecoder().decode(bytes));
    return c.json({ ok: true });
  }

  /** Opaque storage for one encrypted book snapshot. See `vault-store.ts`. */
  private async vaultGetSnapshot(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (session?.totp_verified !== 1) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const bytes = await this.vault.loadSnapshot(
      c.get("bookId"),
      c.req.param("id") ?? "",
    );
    if (!bytes) return c.json({ error: "not_found" }, 404);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Response(copy, {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private async vaultPutSnapshot(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (session?.totp_verified !== 1) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    await this.vault.saveSnapshot(c.get("bookId"), c.req.param("id") ?? "", bytes);
    return c.json({ ok: true });
  }

  /**
   * Plumbing-only check that the first-ever client-side JS bundle in this
   * repo (`apps/web/src/client/vault.ts`, built by `pnpm build:client` into
   * `apps/web/static/vault.js` and served by Workers Assets) actually
   * loads and runs in a real browser. Kept alongside the real vault page
   * above as a minimal smoke check of the bundle/static-serving plumbing
   * itself (issue #88, Workstream 2).
   */
  private async vaultBundleCheckPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    return c.html(
      this.appPage(
        "Vault bundle check",
        `<h1>Vault bundle check</h1>
<p>Client bundle status: <strong data-vault-bundle-status>pending</strong></p>
<script type="module" src="/vault.js"></script>`,
      ),
      200,
    );
  }

  /**
   * Every save writes a new encrypted R2 object rather than overwriting, so
   * this lists the real history of a book and lets the owner roll back to
   * any of them if the current version looks wrong or corrupted.
   */
  private async versionsPage(c: BookContext, notice = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const versions = await this.store.versions(bookId);
    const rows = versions
      .map((version, index) => {
        const label = index === 0 ? ' <span class="chip">Current</span>' : "";
        return `<li class="card" style="margin-bottom:0.5rem">
<span>${escapeHtml(version.timestamp)}</span>${label}
${
  index === 0
    ? ""
    : `<form method="post" action="/app/settings/versions/${escapeHtml(encodeURIComponent(version.id))}/restore">
<button type="submit" class="secondary">Restore this version</button>
</form>`
}
</li>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "Backups and version history",
        `<h1>Backups and version history</h1>
<p class="muted">Every save keeps the version before it. Restoring copies an old version back as the newest one -- nothing is deleted, so you can always change your mind again.</p>
${notice ? `<p class="muted">${escapeHtml(notice)}</p>` : ""}
<ul style="list-style:none;padding:0">${rows || `<p class="muted">No versions yet.</p>`}</ul>
<p><a href="/app/settings">Back to settings</a></p>`,
      ),
      200,
    );
  }

  private async restoreVersion(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const id = decodeURIComponent(c.req.param("id") ?? "");
    const restored = await this.store.restore(bookId, id, nowIso());
    if (!restored) return c.text("That version no longer exists", 404);
    return c.redirect("/app/settings/versions");
  }

  // MARK: - Clients (GncCustomer)

  private async customersPage(c: BookContext, notice = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const customers = (document?.customers() ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const rows = customers
      .map(
        (customer) =>
          `<li class="card" style="margin-bottom:0.5rem"><a href="/app/customers/${escapeHtml(customer.guid)}/edit"><strong>${escapeHtml(customer.name)}</strong></a>${customer.email ? `<p class="muted">${escapeHtml(customer.email)}</p>` : ""}</li>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "Clients",
        `<h1>Clients</h1>
${notice ? `<p class="muted">${escapeHtml(notice)}</p>` : ""}
<p><a class="button secondary" href="/app/customers/new">Add client</a></p>
<ul style="list-style:none;padding:0">${rows || `<p class="muted">No clients yet.</p>`}</ul>`,
      ),
      200,
    );
  }

  private async newCustomerPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    return c.html(
      this.appPage(
        "Add client",
        `<h1>Add client</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/customers">
${this.customerFormFields()}
<button type="submit">Add client</button>
</form>
<p><a href="/app/customers">Cancel</a></p>`,
      ),
      200,
    );
  }

  private customerFormFields(customer?: XmlCustomer): string {
    return `<label for="name">Name</label>
<input id="name" name="name" type="text" required maxlength="200" value="${escapeHtml(customer?.name ?? "")}">
<label for="customer_number">Client number</label>
<input id="customer_number" name="customer_number" type="text" maxlength="40" value="${escapeHtml(customer?.customerNumber ?? "")}">
<label for="address_line1">Address</label>
<input id="address_line1" name="address_line1" type="text" value="${escapeHtml(customer?.addressLine1 ?? "")}">
<label for="phone">Phone</label>
<input id="phone" name="phone" type="tel" value="${escapeHtml(customer?.phone ?? "")}">
<label for="email">Email</label>
<input id="email" name="email" type="email" value="${escapeHtml(customer?.email ?? "")}">
<label for="notes">Notes</label>
<textarea id="notes" name="notes" rows="3">${escapeHtml(customer?.notes ?? "")}</textarea>`;
  }

  private async createCustomer(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    if (!name || name.length > 200) {
      return this.newCustomerPage(c, "Enter a name.");
    }
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const currency = this.bookById(bookId)?.currency ?? "USD";
    document.createCustomer(
      {
        name,
        customerNumber: formValue(body, "customer_number"),
        addressLine1: formValue(body, "address_line1"),
        phone: formValue(body, "phone"),
        email: formValue(body, "email"),
        notes: formValue(body, "notes"),
        currency: { space: "CURRENCY", id: currency },
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/customers");
  }

  private async editCustomerPage(
    c: BookContext,
    guid: string,
    error = "",
  ): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const customer = document?.customer(guid);
    if (!customer) return c.text("Client not found", 404);
    return c.html(
      this.appPage(
        "Edit client",
        `<h1>Edit client</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/customers/${escapeHtml(guid)}">
${this.customerFormFields(customer)}
<button type="submit">Save client</button>
</form>
<form method="post" action="/app/customers/${escapeHtml(guid)}/delete">
<button type="submit" class="danger">Delete client</button>
</form>
<p><a href="/app/customers">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async updateCustomer(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.customer(guid)) return c.text("Client not found", 404);
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    if (!name || name.length > 200) {
      return this.editCustomerPage(c, guid, "Enter a name.");
    }
    document.updateCustomer(guid, {
      name,
      customerNumber: formValue(body, "customer_number"),
      addressLine1: formValue(body, "address_line1"),
      phone: formValue(body, "phone"),
      email: formValue(body, "email"),
      notes: formValue(body, "notes"),
    });
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/customers");
  }

  private async deleteCustomer(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.customer(guid)) return c.text("Client not found", 404);
    if (document.customerInUse(guid)) {
      return this.editCustomerPage(
        c,
        guid,
        "This client has invoices and cannot be deleted.",
      );
    }
    document.deleteCustomer(guid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/customers");
  }

  // MARK: - Invoices (GncInvoice / GncEntry)

  private incomeAccountRows(
    document: { accounts(): XmlAccount[] } | null,
  ): XmlAccount[] {
    return (document?.accounts() ?? []).filter(
      (account) => account.type === "INCOME" && !account.placeholder,
    );
  }

  private receivableAccountRows(
    document: { accounts(): XmlAccount[] } | null,
  ): XmlAccount[] {
    const types = new Set(["ASSET", "BANK", "CASH", "RECEIVABLE"]);
    return (document?.accounts() ?? []).filter(
      (account) => types.has(account.type) && !account.placeholder,
    );
  }

  private async invoicesPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const invoices = (document?.invoices() ?? []).sort((a, b) =>
      b.dateOpened.localeCompare(a.dateOpened),
    );
    const customers = new Map(
      (document?.customers() ?? []).map((customer) => [customer.guid, customer.name]),
    );
    const rows = invoices
      .map((invoice) => {
        const entries = document?.invoiceEntries(invoice.guid) ?? [];
        const total = entries.reduce(
          (sum, entry) => addMoney(sum, multiplyMoney(entry.quantity, entry.unitPrice)),
          money(0n),
        );
        return `<li class="card" style="margin-bottom:0.5rem">
<a href="/app/invoices/${escapeHtml(invoice.guid)}"><strong>${escapeHtml(invoice.invoiceNumber || "Invoice")}</strong></a>
<span class="chip">${invoice.datePosted ? "Posted" : "Draft"}</span>
<p class="muted">${escapeHtml(customers.get(invoice.customerGuid) ?? "Unknown client")} &middot; ${formatMoney(total, 100n)}</p>
</li>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "Invoices",
        `<h1>Invoices</h1>
<p>
<a class="button secondary" href="/app/invoices/new">New invoice</a>
<a class="button secondary" href="/app/customers">Clients</a>
</p>
<ul style="list-style:none;padding:0">${rows || `<p class="muted">No invoices yet.</p>`}</ul>`,
      ),
      200,
    );
  }

  private async newInvoicePage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const customers = (document?.customers() ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (customers.length === 0) {
      return c.html(
        this.appPage(
          "New invoice",
          `<h1>New invoice</h1>
<p class="error">Add a client before creating an invoice.</p>
<p><a href="/app/customers/new">Add client</a></p>`,
        ),
        200,
      );
    }
    const options = customers
      .map(
        (customer) =>
          `<option value="${escapeHtml(customer.guid)}">${escapeHtml(customer.name)}</option>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "New invoice",
        `<h1>New invoice</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/invoices">
<label for="customer">Client</label>
<select id="customer" name="customer">${options}</select>
<label for="invoice_number">Invoice number</label>
<input id="invoice_number" name="invoice_number" type="text" required maxlength="40">
<label for="date_opened">Date opened</label>
<input id="date_opened" name="date_opened" type="date" required value="${nowIso().slice(0, 10)}">
<button type="submit">Create</button>
</form>
<p><a href="/app/invoices">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async createInvoice(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const customerGuid = formValue(body, "customer");
    const invoiceNumber = formValue(body, "invoice_number");
    const dateOpened = formValue(body, "date_opened");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOpened)) {
      return this.newInvoicePage(c, "Enter a valid date.");
    }
    if (!invoiceNumber) {
      return this.newInvoicePage(c, "Enter an invoice number.");
    }
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.customer(customerGuid)) {
      return this.newInvoicePage(c, "Choose a valid client.");
    }
    const currency = this.bookById(bookId)?.currency ?? "USD";
    const invoice = document.createInvoice(
      {
        customerGuid,
        invoiceNumber,
        dateOpened,
        currency: { space: "CURRENCY", id: currency },
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/invoices/${invoice.guid}`);
  }

  private async invoiceDetailPage(
    c: BookContext,
    guid: string,
    notice = "",
  ): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const invoice = document?.invoice(guid);
    if (!invoice || !document) return c.text("Invoice not found", 404);
    const customer = document.customer(invoice.customerGuid);
    const entries = document.invoiceEntries(guid);
    const total = entries.reduce(
      (sum, entry) => addMoney(sum, multiplyMoney(entry.quantity, entry.unitPrice)),
      money(0n),
    );
    const accounts = new Map(
      document.accounts().map((account) => [account.guid, account.name]),
    );
    const lineRows = entries
      .map((entry) => {
        const amount = multiplyMoney(entry.quantity, entry.unitPrice);
        const deleteForm = invoice.datePosted
          ? ""
          : `<form method="post" action="/app/invoices/${escapeHtml(guid)}/lines/${escapeHtml(entry.guid)}/delete"><button type="submit" class="secondary">Remove</button></form>`;
        return `<li><span>${escapeHtml(entry.description)} <span class="muted">(${accounts.get(entry.incomeAccountGuid) ?? "?"})</span></span><span class="amount">${formatMoney(amount, 100n)}</span>${deleteForm}</li>`;
      })
      .join("");
    const incomeOptions = this.incomeAccountRows(document)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)}</option>`,
      )
      .join("");
    const receivableOptions = this.receivableAccountRows(document)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)}</option>`,
      )
      .join("");
    const actions = invoice.datePosted
      ? `<p class="muted">Posted ${escapeHtml(invoice.datePosted.slice(0, 10))}.</p>`
      : `<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Add a line</h2>
<form method="post" action="/app/invoices/${escapeHtml(guid)}/lines">
<label for="description">Description</label>
<input id="description" name="description" type="text" required>
<label for="line_date">Date</label>
<input id="line_date" name="line_date" type="date" required value="${nowIso().slice(0, 10)}">
<label for="quantity">Quantity</label>
<input id="quantity" name="quantity" value="1" required>
<label for="unit_price">Unit price</label>
<input id="unit_price" name="unit_price" placeholder="250.00" required>
<label for="income_account">Income account</label>
<select id="income_account" name="income_account">${incomeOptions}</select>
<button type="submit">Add line</button>
</form>
</div>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Post invoice</h2>
<p class="muted">Posting debits the account below for ${formatMoney(total, 100n)} and credits each line's income account. This cannot be undone.</p>
<form method="post" action="/app/invoices/${escapeHtml(guid)}/post">
<label for="receivable_account">Deposit to</label>
<select id="receivable_account" name="receivable_account">${receivableOptions}</select>
<label for="posted_date">Posted date</label>
<input id="posted_date" name="posted_date" type="date" required value="${nowIso().slice(0, 10)}">
<button type="submit" ${entries.length === 0 ? "disabled" : ""}>Post invoice</button>
</form>
</div>
<form method="post" action="/app/invoices/${escapeHtml(guid)}/delete" style="margin-top:1rem">
<button type="submit" class="danger">Delete draft</button>
</form>`;
    return c.html(
      this.appPage(
        invoice.invoiceNumber || "Invoice",
        `<h1>${escapeHtml(invoice.invoiceNumber || "Invoice")}</h1>
${notice ? `<p class="error">${escapeHtml(notice)}</p>` : ""}
<p class="muted">Client: <strong>${escapeHtml(customer?.name ?? "Unknown")}</strong> &middot; Opened ${escapeHtml(invoice.dateOpened.slice(0, 10))}</p>
<ul class="journal">${lineRows || `<li><span class="muted">No lines yet.</span></li>`}</ul>
<p><strong>Total: ${formatMoney(total, 100n)}</strong></p>
${actions}
<p><a href="/app/invoices">Back to invoices</a></p>`,
      ),
      200,
    );
  }

  private async addInvoiceLine(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const invoice = document?.invoice(guid);
    if (!invoice || !document) return c.text("Invoice not found", 404);
    if (invoice.datePosted)
      return this.invoiceDetailPage(c, guid, "A posted invoice cannot be edited.");
    const body = await c.req.parseBody();
    const description = formValue(body, "description");
    const lineDate = formValue(body, "line_date");
    const incomeAccount = formValue(body, "income_account");
    if (
      !description ||
      !/^\d{4}-\d{2}-\d{2}$/.test(lineDate) ||
      !document.account(incomeAccount)
    ) {
      return this.invoiceDetailPage(
        c,
        guid,
        "Fill in every field with a valid income account.",
      );
    }
    let quantity: Money;
    let unitPrice: Money;
    try {
      quantity = parseMoneyHalfUp(formValue(body, "quantity"), 10000n);
      unitPrice = parseMoneyHalfUp(formValue(body, "unit_price"), 100n);
    } catch {
      return this.invoiceDetailPage(c, guid, "Enter a valid quantity and unit price.");
    }
    if (isZeroMoney(quantity) || isZeroMoney(unitPrice)) {
      return this.invoiceDetailPage(
        c,
        guid,
        "Quantity and unit price must not be zero.",
      );
    }
    document.addInvoiceEntry(
      {
        invoiceGuid: guid,
        date: lineDate,
        description,
        quantity,
        unitPrice,
        incomeAccountGuid: incomeAccount,
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/invoices/${guid}`);
  }

  private async deleteInvoiceLine(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const lineGuid = c.req.param("lineGuid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const invoice = document?.invoice(guid);
    if (!invoice || !document) return c.text("Invoice not found", 404);
    if (invoice.datePosted)
      return this.invoiceDetailPage(c, guid, "A posted invoice cannot be edited.");
    document.deleteInvoiceEntry(lineGuid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/invoices/${guid}`);
  }

  private async deleteInvoiceDraft(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const invoice = document?.invoice(guid);
    if (!invoice || !document) return c.text("Invoice not found", 404);
    if (invoice.datePosted)
      return this.invoiceDetailPage(c, guid, "A posted invoice cannot be deleted.");
    document.deleteInvoice(guid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/invoices");
  }

  /**
   * Posts a draft invoice: debits the chosen receivable account for the
   * total and credits each line's income account -- the same effect as
   * desktop GnuCash's own "Post Invoice". One-way: a posted invoice is
   * permanent ledger history and can no longer be edited or deleted.
   */
  private async postInvoice(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const invoice = document?.invoice(guid);
    if (!invoice || !document) return c.text("Invoice not found", 404);
    if (invoice.datePosted)
      return this.invoiceDetailPage(c, guid, "This invoice is already posted.");
    const body = await c.req.parseBody();
    const receivableAccount = formValue(body, "receivable_account");
    const postedDate = formValue(body, "posted_date");
    if (!document.account(receivableAccount)) {
      return this.invoiceDetailPage(c, guid, "Choose a valid account.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(postedDate)) {
      return this.invoiceDetailPage(c, guid, "Enter a valid posted date.");
    }
    const entries = document.invoiceEntries(guid);
    if (entries.length === 0) {
      return this.invoiceDetailPage(c, guid, "Add at least one line before posting.");
    }
    const currency = this.bookById(bookId)?.currency ?? "USD";
    let total = money(0n);
    const splits = entries.map((entry) => {
      const amount = multiplyMoney(entry.quantity, entry.unitPrice);
      total = addMoney(total, amount);
      return { accountGuid: entry.incomeAccountGuid, value: negateMoney(amount) };
    });
    splits.push({ accountGuid: receivableAccount, value: total });
    const txGuid = newGuid();
    document.postTransaction(
      {
        currency: { space: "CURRENCY", id: currency },
        datePosted: `${postedDate} 00:00:00 +0000`,
        dateEntered: `${postedDate} 00:00:00 +0000`,
        description: `Invoice ${invoice.invoiceNumber}`,
        splits,
      },
      { transaction: txGuid, splits: splits.map(() => newGuid()) },
    );
    document.markInvoicePosted(guid, postedDate, txGuid, receivableAccount);
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/invoices/${guid}`);
  }

  // MARK: - Vendors (GncVendor)

  private async vendorsPage(c: BookContext, notice = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const vendors = (document?.vendors() ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const rows = vendors
      .map(
        (vendor) =>
          `<li class="card" style="margin-bottom:0.5rem"><a href="/app/vendors/${escapeHtml(vendor.guid)}/edit"><strong>${escapeHtml(vendor.name)}</strong></a>${vendor.email ? `<p class="muted">${escapeHtml(vendor.email)}</p>` : ""}</li>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "Vendors",
        `<h1>Vendors</h1>
${notice ? `<p class="muted">${escapeHtml(notice)}</p>` : ""}
<p><a class="button secondary" href="/app/vendors/new">Add vendor</a></p>
<ul style="list-style:none;padding:0">${rows || `<p class="muted">No vendors yet.</p>`}</ul>`,
      ),
      200,
    );
  }

  private async newVendorPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    return c.html(
      this.appPage(
        "Add vendor",
        `<h1>Add vendor</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/vendors">
${this.vendorFormFields()}
<button type="submit">Add vendor</button>
</form>
<p><a href="/app/vendors">Cancel</a></p>`,
      ),
      200,
    );
  }

  private vendorFormFields(vendor?: XmlVendor): string {
    return `<label for="name">Name</label>
<input id="name" name="name" type="text" required maxlength="200" value="${escapeHtml(vendor?.name ?? "")}">
<label for="vendor_number">Vendor number</label>
<input id="vendor_number" name="vendor_number" type="text" maxlength="40" value="${escapeHtml(vendor?.vendorNumber ?? "")}">
<label for="address_line1">Address</label>
<input id="address_line1" name="address_line1" type="text" value="${escapeHtml(vendor?.addressLine1 ?? "")}">
<label for="phone">Phone</label>
<input id="phone" name="phone" type="tel" value="${escapeHtml(vendor?.phone ?? "")}">
<label for="email">Email</label>
<input id="email" name="email" type="email" value="${escapeHtml(vendor?.email ?? "")}">
<label for="notes">Notes</label>
<textarea id="notes" name="notes" rows="3">${escapeHtml(vendor?.notes ?? "")}</textarea>`;
  }

  private async createVendor(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    if (!name || name.length > 200) {
      return this.newVendorPage(c, "Enter a name.");
    }
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document) return c.text("Book not found", 404);
    const currency = this.bookById(bookId)?.currency ?? "USD";
    document.createVendor(
      {
        name,
        vendorNumber: formValue(body, "vendor_number"),
        addressLine1: formValue(body, "address_line1"),
        phone: formValue(body, "phone"),
        email: formValue(body, "email"),
        notes: formValue(body, "notes"),
        currency: { space: "CURRENCY", id: currency },
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/vendors");
  }

  private async editVendorPage(
    c: BookContext,
    guid: string,
    error = "",
  ): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const vendor = document?.vendor(guid);
    if (!vendor) return c.text("Vendor not found", 404);
    return c.html(
      this.appPage(
        "Edit vendor",
        `<h1>Edit vendor</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/vendors/${escapeHtml(guid)}">
${this.vendorFormFields(vendor)}
<button type="submit">Save vendor</button>
</form>
<form method="post" action="/app/vendors/${escapeHtml(guid)}/delete">
<button type="submit" class="danger">Delete vendor</button>
</form>
<p><a href="/app/vendors">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async updateVendorRoute(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.vendor(guid)) return c.text("Vendor not found", 404);
    const body = await c.req.parseBody();
    const name = formValue(body, "name");
    if (!name || name.length > 200) {
      return this.editVendorPage(c, guid, "Enter a name.");
    }
    document.updateVendor(guid, {
      name,
      vendorNumber: formValue(body, "vendor_number"),
      addressLine1: formValue(body, "address_line1"),
      phone: formValue(body, "phone"),
      email: formValue(body, "email"),
      notes: formValue(body, "notes"),
    });
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/vendors");
  }

  private async deleteVendorRoute(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.vendor(guid)) return c.text("Vendor not found", 404);
    if (document.vendorInUse(guid)) {
      return this.editVendorPage(
        c,
        guid,
        "This vendor has bills and cannot be deleted.",
      );
    }
    document.deleteVendor(guid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/vendors");
  }

  // MARK: - Bills (GncInvoice / GncEntry, vendor-owned)

  private expenseAccountRows(
    document: { accounts(): XmlAccount[] } | null,
  ): XmlAccount[] {
    return (document?.accounts() ?? []).filter(
      (account) => account.type === "EXPENSE" && !account.placeholder,
    );
  }

  private payableAccountRows(
    document: { accounts(): XmlAccount[] } | null,
  ): XmlAccount[] {
    const types = new Set(["ASSET", "BANK", "CASH", "LIABILITY", "CREDIT", "PAYABLE"]);
    return (document?.accounts() ?? []).filter(
      (account) => types.has(account.type) && !account.placeholder,
    );
  }

  private async billsPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const bills = (document?.bills() ?? []).sort((a, b) =>
      b.dateOpened.localeCompare(a.dateOpened),
    );
    const vendors = new Map(
      (document?.vendors() ?? []).map((vendor) => [vendor.guid, vendor.name]),
    );
    const rows = bills
      .map((bill) => {
        const entries = document?.billEntries(bill.guid) ?? [];
        const total = entries.reduce(
          (sum, entry) => addMoney(sum, multiplyMoney(entry.quantity, entry.unitPrice)),
          money(0n),
        );
        return `<li class="card" style="margin-bottom:0.5rem">
<a href="/app/bills/${escapeHtml(bill.guid)}"><strong>${escapeHtml(bill.billNumber || "Bill")}</strong></a>
<span class="chip">${bill.datePosted ? "Posted" : "Draft"}</span>
<p class="muted">${escapeHtml(vendors.get(bill.vendorGuid) ?? "Unknown vendor")} &middot; ${formatMoney(total, 100n)}</p>
</li>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "Bills",
        `<h1>Bills</h1>
<p>
<a class="button secondary" href="/app/bills/new">New bill</a>
<a class="button secondary" href="/app/vendors">Vendors</a>
</p>
<ul style="list-style:none;padding:0">${rows || `<p class="muted">No bills yet.</p>`}</ul>`,
      ),
      200,
    );
  }

  private async newBillPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const vendors = (document?.vendors() ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (vendors.length === 0) {
      return c.html(
        this.appPage(
          "New bill",
          `<h1>New bill</h1>
<p class="error">Add a vendor before creating a bill.</p>
<p><a href="/app/vendors/new">Add vendor</a></p>`,
        ),
        200,
      );
    }
    const options = vendors
      .map(
        (vendor) =>
          `<option value="${escapeHtml(vendor.guid)}">${escapeHtml(vendor.name)}</option>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "New bill",
        `<h1>New bill</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/bills">
<label for="vendor">Vendor</label>
<select id="vendor" name="vendor">${options}</select>
<label for="bill_number">Bill number</label>
<input id="bill_number" name="bill_number" type="text" required maxlength="40">
<label for="date_opened">Date opened</label>
<input id="date_opened" name="date_opened" type="date" required value="${nowIso().slice(0, 10)}">
<button type="submit">Create</button>
</form>
<p><a href="/app/bills">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async createBillRoute(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const vendorGuid = formValue(body, "vendor");
    const billNumber = formValue(body, "bill_number");
    const dateOpened = formValue(body, "date_opened");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOpened)) {
      return this.newBillPage(c, "Enter a valid date.");
    }
    if (!billNumber) {
      return this.newBillPage(c, "Enter a bill number.");
    }
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.vendor(vendorGuid)) {
      return this.newBillPage(c, "Choose a valid vendor.");
    }
    const currency = this.bookById(bookId)?.currency ?? "USD";
    const bill = document.createBill(
      {
        vendorGuid,
        billNumber,
        dateOpened,
        currency: { space: "CURRENCY", id: currency },
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/bills/${bill.guid}`);
  }

  private async billDetailPage(
    c: BookContext,
    guid: string,
    notice = "",
  ): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const bill = document?.bill(guid);
    if (!bill || !document) return c.text("Bill not found", 404);
    const vendor = document.vendor(bill.vendorGuid);
    const entries = document.billEntries(guid);
    const total = entries.reduce(
      (sum, entry) => addMoney(sum, multiplyMoney(entry.quantity, entry.unitPrice)),
      money(0n),
    );
    const accounts = new Map(
      document.accounts().map((account) => [account.guid, account.name]),
    );
    const lineRows = entries
      .map((entry) => {
        const amount = multiplyMoney(entry.quantity, entry.unitPrice);
        const deleteForm = bill.datePosted
          ? ""
          : `<form method="post" action="/app/bills/${escapeHtml(guid)}/lines/${escapeHtml(entry.guid)}/delete"><button type="submit" class="secondary">Remove</button></form>`;
        return `<li><span>${escapeHtml(entry.description)} <span class="muted">(${accounts.get(entry.expenseAccountGuid) ?? "?"})</span></span><span class="amount">${formatMoney(amount, 100n)}</span>${deleteForm}</li>`;
      })
      .join("");
    const expenseOptions = this.expenseAccountRows(document)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)}</option>`,
      )
      .join("");
    const payableOptions = this.payableAccountRows(document)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)}</option>`,
      )
      .join("");
    const actions = bill.datePosted
      ? `<p class="muted">Posted ${escapeHtml(bill.datePosted.slice(0, 10))}.</p>`
      : `<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Add a line</h2>
<form method="post" action="/app/bills/${escapeHtml(guid)}/lines">
<label for="description">Description</label>
<input id="description" name="description" type="text" required>
<label for="line_date">Date</label>
<input id="line_date" name="line_date" type="date" required value="${nowIso().slice(0, 10)}">
<label for="quantity">Quantity</label>
<input id="quantity" name="quantity" value="1" required>
<label for="unit_price">Unit price</label>
<input id="unit_price" name="unit_price" placeholder="250.00" required>
<label for="expense_account">Expense account</label>
<select id="expense_account" name="expense_account">${expenseOptions}</select>
<button type="submit">Add line</button>
</form>
</div>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Post bill</h2>
<p class="muted">Posting debits each line's expense account and credits the account below for ${formatMoney(total, 100n)}. This cannot be undone.</p>
<form method="post" action="/app/bills/${escapeHtml(guid)}/post">
<label for="payable_account">Pay from</label>
<select id="payable_account" name="payable_account">${payableOptions}</select>
<label for="posted_date">Posted date</label>
<input id="posted_date" name="posted_date" type="date" required value="${nowIso().slice(0, 10)}">
<button type="submit" ${entries.length === 0 ? "disabled" : ""}>Post bill</button>
</form>
</div>
<form method="post" action="/app/bills/${escapeHtml(guid)}/delete" style="margin-top:1rem">
<button type="submit" class="danger">Delete draft</button>
</form>`;
    return c.html(
      this.appPage(
        bill.billNumber || "Bill",
        `<h1>${escapeHtml(bill.billNumber || "Bill")}</h1>
${notice ? `<p class="error">${escapeHtml(notice)}</p>` : ""}
<p class="muted">Vendor: <strong>${escapeHtml(vendor?.name ?? "Unknown")}</strong> &middot; Opened ${escapeHtml(bill.dateOpened.slice(0, 10))}</p>
<ul class="journal">${lineRows || `<li><span class="muted">No lines yet.</span></li>`}</ul>
<p><strong>Total: ${formatMoney(total, 100n)}</strong></p>
${actions}
<p><a href="/app/bills">Back to bills</a></p>`,
      ),
      200,
    );
  }

  private async addBillLine(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const bill = document?.bill(guid);
    if (!bill || !document) return c.text("Bill not found", 404);
    if (bill.datePosted)
      return this.billDetailPage(c, guid, "A posted bill cannot be edited.");
    const body = await c.req.parseBody();
    const description = formValue(body, "description");
    const lineDate = formValue(body, "line_date");
    const expenseAccount = formValue(body, "expense_account");
    if (
      !description ||
      !/^\d{4}-\d{2}-\d{2}$/.test(lineDate) ||
      !document.account(expenseAccount)
    ) {
      return this.billDetailPage(
        c,
        guid,
        "Fill in every field with a valid expense account.",
      );
    }
    let quantity: Money;
    let unitPrice: Money;
    try {
      quantity = parseMoneyHalfUp(formValue(body, "quantity"), 10000n);
      unitPrice = parseMoneyHalfUp(formValue(body, "unit_price"), 100n);
    } catch {
      return this.billDetailPage(c, guid, "Enter a valid quantity and unit price.");
    }
    if (isZeroMoney(quantity) || isZeroMoney(unitPrice)) {
      return this.billDetailPage(c, guid, "Quantity and unit price must not be zero.");
    }
    document.addBillEntry(
      {
        billGuid: guid,
        date: lineDate,
        description,
        quantity,
        unitPrice,
        expenseAccountGuid: expenseAccount,
      },
      newGuid(),
    );
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/bills/${guid}`);
  }

  private async deleteBillLine(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const lineGuid = c.req.param("lineGuid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const bill = document?.bill(guid);
    if (!bill || !document) return c.text("Bill not found", 404);
    if (bill.datePosted)
      return this.billDetailPage(c, guid, "A posted bill cannot be edited.");
    document.deleteBillEntry(lineGuid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/bills/${guid}`);
  }

  private async deleteBillDraft(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const bill = document?.bill(guid);
    if (!bill || !document) return c.text("Bill not found", 404);
    if (bill.datePosted)
      return this.billDetailPage(c, guid, "A posted bill cannot be deleted.");
    document.deleteBill(guid);
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/bills");
  }

  /**
   * Posts a draft bill: debits each line's expense account and credits
   * the chosen payable account for the total -- the same effect as
   * desktop GnuCash's own "Post Bill". One-way: a posted bill is
   * permanent ledger history and can no longer be edited or deleted.
   */
  private async postBillRoute(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const guid = c.req.param("guid") ?? "";
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const bill = document?.bill(guid);
    if (!bill || !document) return c.text("Bill not found", 404);
    if (bill.datePosted)
      return this.billDetailPage(c, guid, "This bill is already posted.");
    const body = await c.req.parseBody();
    const payableAccount = formValue(body, "payable_account");
    const postedDate = formValue(body, "posted_date");
    if (!document.account(payableAccount)) {
      return this.billDetailPage(c, guid, "Choose a valid account.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(postedDate)) {
      return this.billDetailPage(c, guid, "Enter a valid posted date.");
    }
    const entries = document.billEntries(guid);
    if (entries.length === 0) {
      return this.billDetailPage(c, guid, "Add at least one line before posting.");
    }
    const currency = this.bookById(bookId)?.currency ?? "USD";
    let total = money(0n);
    const splits = entries.map((entry) => {
      const amount = multiplyMoney(entry.quantity, entry.unitPrice);
      total = addMoney(total, amount);
      return { accountGuid: entry.expenseAccountGuid, value: amount };
    });
    splits.push({ accountGuid: payableAccount, value: negateMoney(total) });
    const txGuid = newGuid();
    document.postTransaction(
      {
        currency: { space: "CURRENCY", id: currency },
        datePosted: `${postedDate} 00:00:00 +0000`,
        dateEntered: `${postedDate} 00:00:00 +0000`,
        description: `Bill ${bill.billNumber}`,
        splits,
      },
      { transaction: txGuid, splits: splits.map(() => newGuid()) },
    );
    document.markBillPosted(guid, postedDate, txGuid, payableAccount);
    await this.store.save(bookId, document, nowIso());
    return c.redirect(`/app/bills/${guid}`);
  }

  // MARK: - Receipts (GnuCash "Associate File/Location")

  private async receiptsPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const receiptTransactions = (document?.transactions() ?? []).filter(
      (tx) => tx.docLink,
    );
    const rows = receiptTransactions
      .map((tx) => {
        const amount =
          tx.splits.find((split) => split.value.num > 0n)?.value ?? money(0n);
        return `<li class="card" style="margin-bottom:0.5rem">
<img src="/app/receipts/image/${escapeHtml(tx.guid)}" alt="Receipt" style="max-width:60px;max-height:60px;border-radius:8px;vertical-align:middle;margin-right:0.5rem">
${escapeHtml(tx.description)} &middot; ${escapeHtml(tx.datePosted.slice(0, 10))}
<span class="amount">${formatMoney(amount, 100n)}</span>
</li>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "Receipts",
        `<h1>Receipts</h1>
<p class="muted">Capture a receipt to post the expense it documents.</p>
<p><a class="button secondary" href="/app/receipts/new">Add receipt</a></p>
<ul style="list-style:none;padding:0">${rows || `<p class="muted">No receipts yet.</p>`}</ul>`,
      ),
      200,
    );
  }

  private async newReceiptPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    const expenseOptions = (document?.accounts() ?? [])
      .filter((account) => account.type === "EXPENSE" && !account.placeholder)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)}</option>`,
      )
      .join("");
    const paymentTypes = new Set(["ASSET", "BANK", "CASH", "CREDIT", "LIABILITY"]);
    const paymentOptions = (document?.accounts() ?? [])
      .filter((account) => paymentTypes.has(account.type) && !account.placeholder)
      .map(
        (account) =>
          `<option value="${escapeHtml(account.guid)}">${escapeHtml(account.name)}</option>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "Add receipt",
        `<h1>Add receipt</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/receipts" enctype="multipart/form-data">
<label for="image">Receipt photo</label>
<input id="image" name="image" type="file" accept="image/*" required>
<label for="description">Description</label>
<input id="description" name="description" type="text" required>
<label for="date">Date</label>
<input id="date" name="date" type="date" required value="${nowIso().slice(0, 10)}">
<label for="amount">Amount</label>
<input id="amount" name="amount" inputmode="decimal" placeholder="42.00" required>
<label for="expense_account">Expense account</label>
<select id="expense_account" name="expense_account">${expenseOptions}</select>
<label for="payment_account">Paid from</label>
<select id="payment_account" name="payment_account">${paymentOptions}</select>
<button type="submit">Post expense</button>
</form>
<p><a href="/app/receipts">Cancel</a></p>`,
      ),
      200,
    );
  }

  private async createReceiptExpense(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const body = await c.req.parseBody();
    const file = body.image;
    if (!(file instanceof File))
      return this.newReceiptPage(c, "Choose a receipt photo.");
    const description = formValue(body, "description");
    const date = formValue(body, "date");
    const expenseAccount = formValue(body, "expense_account");
    const paymentAccount = formValue(body, "payment_account");
    if (!description || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return this.newReceiptPage(c, "Fill in a description and a valid date.");
    }
    let amount: Money;
    try {
      amount = parseMoneyHalfUp(formValue(body, "amount"), 100n);
    } catch {
      return this.newReceiptPage(c, "Enter an amount like 42.00.");
    }
    if (isZeroMoney(amount) || amount.num < 0n) {
      return this.newReceiptPage(c, "Enter a positive amount.");
    }
    const bookId = c.get("bookId");
    const document = await this.store.get(bookId);
    if (!document?.account(expenseAccount) || !document.account(paymentAccount)) {
      return this.newReceiptPage(c, "Choose valid accounts.");
    }
    const currency = this.bookById(bookId)?.currency ?? "USD";
    const extension =
      (file.type.split("/")[1] ?? "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const relativePath = await this.receipts.save(bookId, bytes, extension);

    const txGuid = newGuid();
    document.postTransaction(
      {
        currency: { space: "CURRENCY", id: currency },
        datePosted: `${date} 00:00:00 +0000`,
        dateEntered: `${date} 00:00:00 +0000`,
        description,
        splits: [
          { accountGuid: expenseAccount, value: amount },
          { accountGuid: paymentAccount, value: negateMoney(amount) },
        ],
      },
      { transaction: txGuid, splits: [newGuid(), newGuid()] },
    );
    document.setTransactionDocLink(txGuid, relativePath);
    await this.store.save(bookId, document, nowIso());
    return c.redirect("/app/receipts");
  }

  private async receiptImage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const bookId = c.get("bookId");
    const txGuid = c.req.param("txGuid") ?? "";
    const document = await this.store.get(bookId);
    const docLink = document?.transaction(txGuid)?.docLink;
    if (!docLink) return c.text("Not found", 404);
    const bytes = await this.receipts.load(bookId, docLink);
    if (!bytes) return c.text("Not found", 404);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Response(copy, { headers: { "content-type": "image/jpeg" } });
  }

  private async logout(c: BookContext): Promise<Response> {
    if (!isSameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const hash = await this.sessionTokenHash(c);
    if (hash) deleteSession(this.sql, hash);
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", clearedSessionCookie(sessionCookieName(secure), secure));
    return c.redirect("/app/login");
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request, this.env);
  }
}
