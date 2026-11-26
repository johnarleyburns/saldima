// SPDX-License-Identifier: AGPL-3.0-only
import {
  addMoney,
  type BookSnapshot,
  equalsMoney,
  formatMoney,
  isZeroMoney,
  type Money,
  money,
  newGuid,
  parseMoneyHalfUp,
  readBookSnapshot,
  type XmlAccount,
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

/** GnuCash shows "Bank", not "BANK"; keep the wire format uppercase. */
function typeLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
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
    app.get("/app/help", (c) => this.helpPage(c));
    app.get("/app/journal", (c) => this.journalPage(c));
    app.get("/app/journal/new", (c) => this.newTransactionPage(c));
    app.post("/app/journal", (c) => this.createTransaction(c));
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
  ): Promise<Array<{ accountGuid: string; value: Money }>> {
    const document = await this.store.get(bookId);
    if (!document) return [];
    return document
      .transactions()
      .flatMap((transaction) => transaction.splits)
      .map((split) => ({ accountGuid: split.accountGuid, value: split.value }));
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
    const trial = trialBalance(accounts, splits);
    const sheet = balanceSheet(accounts, splits);
    const pnl = incomeStatement(accounts, splits);
    const trialRows = trial.rows
      .map(
        (row) =>
          `<li><span>${escapeHtml(row.name)} <span class="chip type-${escapeHtml(row.type.toLowerCase())}">${escapeHtml(typeLabel(row.type))}</span></span><span class="amount">${formatMoney(row.debit.num === 0n ? row.credit : row.debit, 100n)}</span></li>`,
      )
      .join("");
    return c.html(
      this.appPage(
        "Reports",
        `<h1>Reports</h1>
<p class="muted">Same reports and kernel as the apps. Amounts are half-even for display.</p>
<div class="summary">
<div class="stat accent"><div class="label">Net assets</div><div class="value">${formatMoney(sheet.assets, 100n)}</div></div>
<div class="stat green"><div class="label">Profit</div><div class="value">${formatMoney(pnl.netIncome, 100n)}</div></div>
<div class="stat blue"><div class="label">Trial balance</div><div class="value">${trial.balanced ? "Balanced" : "Out"}</div></div>
</div>
<div class="card"><h2 style="margin-top:0">Trial balance</h2><ul class="journal">${trialRows || `<li><span class="muted">No postings yet.</span></li>`}</ul></div>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Balance sheet</h2>
<ul class="journal">
<li><span>Assets</span><span class="amount">${formatMoney(sheet.assets, 100n)}</span></li>
<li><span>Liabilities</span><span class="amount">${formatMoney(sheet.liabilities, 100n)}</span></li>
<li><span>Equity</span><span class="amount">${formatMoney(addMoney(sheet.equity, sheet.retainedEarnings), 100n)}</span></li>
</ul></div>
<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Profit &amp; loss</h2>
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
    const txs = (document?.transactions() ?? [])
      .slice()
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
        return `<div class="card" style="margin-bottom:1rem"><h2 style="margin:0">${escapeHtml(tx.description)}</h2><p class="muted">${escapeHtml(tx.datePosted.slice(0, 10))}</p><ul class="journal">${rows}</ul></div>`;
      })
      .join("");
    return c.html(
      this.appPage(
        "General Journal",
        `<h1>General Journal</h1>
<p class="muted">Every transaction in this book, like Tools → General Journal.</p>
<p><a href="/app/journal/new" class="cta">New transaction</a></p>
${items || `<p class="muted">No transactions yet.</p>`}${txs.length > 200 ? `<p class="muted">Showing the most recent 200 of ${txs.length} transactions.</p>` : ""}`,
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
<nav><a href="/app/accounts">Accounts</a><a href="/app/journal">Journal</a><a href="/app/reports">Reports</a><a href="/app/books">Books</a><a href="/app/help">Help</a><a href="/app/settings">Settings</a></nav>
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
