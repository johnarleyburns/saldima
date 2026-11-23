// SPDX-License-Identifier: AGPL-3.0-only
import { newGuid } from "@saldima/gnucash";
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
import { deleteSession } from "./data-access/auth-store.ts";
import { totpQrSvg } from "./qr.ts";
import {
  ACCOUNT_TYPES,
  type AccountType,
  type BookTemplate,
  flattenTemplate,
  TEMPLATE_IDS,
  templateById,
} from "./templates.ts";
import { epochMs, isoAfterSeconds, nowIso } from "./time/system-clock.ts";

export interface BookEnv {
  ENVIRONMENT?: string;
  SETUP_TOKEN?: string;
  MASTER_KEY?: string;
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

type BookVariables = { tenantId: string };
type BookContext = Context<{ Bindings: BookEnv; Variables: BookVariables }>;
type BookApp = Hono<{ Bindings: BookEnv; Variables: BookVariables }>;

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

interface AccountRow {
  guid: string;
  name: string;
  account_type: string;
  parent_guid: string | null;
  code: string | null;
  hidden: number;
  placeholder: number;
}

interface AccountNode extends AccountRow {
  children: AccountNode[];
}

const SESSION_SECONDS = 30 * 24 * 60 * 60;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — Saldima</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 26rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
p { line-height: 1.5; }
label { display: block; margin-top: 1rem; font-weight: 600; }
input { box-sizing: border-box; width: 100%; min-height: 44px; margin-top: 0.35rem; padding: 0.6rem 0.75rem; font: inherit; border: 1px solid GrayText; border-radius: 0.5rem; background: Field; color: FieldText; }
button { min-height: 44px; margin-top: 1.25rem; width: 100%; font: inherit; font-weight: 650; border: 0; border-radius: 0.5rem; background: #12664f; color: white; cursor: pointer; }
.error { padding: 0.75rem; border-radius: 0.5rem; background: #7f1d1d; color: white; }
.muted { color: GrayText; font-size: 0.9rem; }
code { display: block; overflow-wrap: anywhere; padding: 0.75rem; background: Field; border: 1px solid GrayText; border-radius: 0.5rem; }
.qr { max-width: 15rem; margin: 1rem auto; padding: 0.75rem; background: white; border-radius: 0.75rem; }
.qr svg { display: block; width: 100%; height: auto; }
nav a { color: inherit; }
</style>
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

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: BookEnv,
  ) {
    this.migrate();
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
      `CREATE TABLE IF NOT EXISTS accounts (
        guid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        commodity_guid TEXT,
        parent_guid TEXT,
        code TEXT,
        description TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        placeholder INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
    );
  }

  private buildApp(): BookApp {
    const app = new Hono<{ Bindings: BookEnv; Variables: BookVariables }>();
    app.use("*", async (c, next) => {
      c.set("tenantId", this.state.id.toString());
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
    app.get("/health", (c) =>
      c.json({
        ok: true,
        tenant: c.get("tenantId"),
        runtime: "durable-object",
      }),
    );
    app.get("/app", (c) => this.dashboard(c));
    app.get("/app/login", (c) => this.loginPage(c));
    app.post("/app/login", (c) => this.login(c));
    app.post("/app/logout", (c) => this.logout(c));
    app.get("/app/setup", (c) => this.setupPage(c));
    app.post("/app/setup", (c) => this.setup(c));
    app.get("/app/accounts", (c) => this.accountsPage(c));
    app.get("/app/accounts/new", (c) => this.newAccountPage(c));
    app.post("/app/accounts", (c) => this.createAccount(c));
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

  private setupAllowed(): boolean {
    if (this.userCount() > 0) return false;
    if (this.env.SETUP_TOKEN) return true;
    return this.env.ENVIRONMENT === "local";
  }

  private setupPage(c: BookContext, error = ""): Response {
    if (!this.setupAllowed()) return c.text("Not found", 404);
    const tokenField = this.env.SETUP_TOKEN
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
<input id="email" name="email" type="email" autocomplete="username" required>
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
    if (!this.setupAllowed()) return c.text("Not found", 404);
    const body = await c.req.parseBody();
    if (
      this.env.SETUP_TOKEN &&
      !timingSafeStringEqual(formValue(body, "token"), this.env.SETUP_TOKEN)
    ) {
      return this.setupPage(c, "The setup token is incorrect.");
    }
    const name = formValue(body, "name");
    const email = formValue(body, "email").toLowerCase();
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
    this.seedAccounts(templateById(formValue(body, "template")));
    await this.startSession(c, userId);
    return c.redirect("/app/security/totp");
  }

  private async totpPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified === 1) return c.redirect("/app");
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
    if (session.totp_verified === 1) return c.redirect("/app");
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
    return c.redirect("/app");
  }

  private accountRows(): AccountRow[] {
    return this.rows<AccountRow>(
      `SELECT guid, name, account_type, parent_guid, code, hidden, placeholder
       FROM accounts ORDER BY name`,
    );
  }

  private seedAccounts(template: BookTemplate): void {
    const guids = new Map<string, string>();
    for (const row of flattenTemplate(template)) {
      const parent = row.parentPath ? (guids.get(row.parentPath) ?? null) : null;
      const guid = newGuid();
      this.sql.exec(
        `INSERT INTO accounts
         (guid, name, account_type, commodity_guid, parent_guid, code,
          description, hidden, placeholder, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
        guid,
        row.name,
        row.type,
        parent,
        row.code,
        row.hidden ? 1 : 0,
        row.placeholder ? 1 : 0,
        nowIso(),
      );
      guids.set(row.path, guid);
    }
  }

  private accountsTree(): AccountNode[] {
    const rows = this.accountRows();
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

  private renderAccountTree(nodes: AccountNode[], depth = 0): string {
    if (nodes.length === 0) return `<p class="muted">No accounts yet.</p>`;
    const items = nodes
      .map((node) => {
        const flags = [
          node.hidden ? "hidden" : "",
          node.placeholder ? "placeholder" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<li data-account-name="${escapeHtml(node.name)}">
<strong>${escapeHtml(node.name)}</strong>
<span class="muted">${escapeHtml(node.account_type)}${flags ? ` · ${flags}` : ""}</span>
${this.renderAccountTree(node.children, depth + 1)}
</li>`;
      })
      .join("");
    return `<ul class="accounts">${items}</ul>`;
  }

  private accountOptions(): string {
    const visit = (nodes: AccountNode[], depth: number): string =>
      nodes
        .map((node) => {
          const label = `${"  ".repeat(depth)}${node.name} (${node.account_type})`;
          return `<option value="${escapeHtml(node.guid)}">${escapeHtml(label)}</option>${visit(node.children, depth + 1)}`;
        })
        .join("");
    return `<option value="">No parent (top level)</option>${visit(this.accountsTree(), 0)}`;
  }

  private async accountsPage(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    return c.html(
      page(
        "Chart of accounts",
        `<h1>Chart of accounts</h1>
<p><a href="/app">Back</a> · <a href="/app/accounts/new">Add account</a></p>
${this.renderAccountTree(this.accountsTree())}`,
      ),
      200,
    );
  }

  private async newAccountPage(c: BookContext, error = ""): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    return c.html(
      page(
        "Add account",
        `<h1>Add account</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/app/accounts">
<label for="name">Name</label>
<input id="name" name="name" type="text" required maxlength="200">
<label for="type">Type</label>
<select id="type" name="type">${ACCOUNT_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("")}</select>
<label for="parent">Parent</label>
<select id="parent" name="parent">${this.accountOptions()}</select>
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
    if (!name || name.length > 200 || !ACCOUNT_TYPES.includes(type as AccountType)) {
      return this.newAccountPage(c, "Enter a name and choose a valid account type.");
    }
    if (parent && !this.accountRows().some((row) => row.guid === parent)) {
      return this.newAccountPage(c, "The selected parent no longer exists.");
    }
    this.sql.exec(
      `INSERT INTO accounts
       (guid, name, account_type, commodity_guid, parent_guid, code,
        description, hidden, placeholder, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, NULL, 0, 0, ?)`,
      newGuid(),
      name,
      type,
      parent || null,
      nowIso(),
    );
    return c.redirect("/app/accounts");
  }

  private async dashboard(c: BookContext): Promise<Response> {
    const session = await this.currentSession(c);
    if (!session) return c.redirect("/app/login");
    if (session.totp_verified !== 1) return c.redirect("/app/security/totp");
    const user = this.userById(session.user_id);
    if (!user) return c.redirect("/app/login");
    return c.html(
      page(
        "Book",
        `<h1>Saldima</h1>
<p class="muted">Book ${escapeHtml(c.get("tenantId"))}</p>
<p>Signed in as <strong>${escapeHtml(user.email)}</strong> (${escapeHtml(user.role)}).</p>
<p><a href="/app/accounts">Chart of accounts (${this.accountRows().length})</a></p>
<form method="post" action="/app/logout"><button type="submit">Sign out</button></form>`,
      ),
      200,
    );
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
