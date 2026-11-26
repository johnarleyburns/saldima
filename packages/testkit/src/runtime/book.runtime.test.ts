// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { totpCode } from "../../../../apps/web/src/auth.ts";

interface BookNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    BOOK: BookNamespaceLike;
    PROVISION_SECRET: string;
  }
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("missing session cookie");
  return header.split(";")[0] ?? "";
}

async function request(
  stub: { fetch(request: Request): Promise<Response> },
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return stub.fetch(
    new Request(`https://alice.localhost${path}`, {
      redirect: "manual",
      ...init,
      headers: {
        Origin: "https://alice.localhost",
        ...(init.headers ?? {}),
      },
    }),
  );
}

describe("Book provisioning in workerd", () => {
  it("exchanges the provision secret for a one-time setup link", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName("tenant-provision-test"));
    const provision = await stub.fetch(
      new Request("https://book.internal/internal/provision", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PROVISION_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "provisioned@example.test" }),
      }),
    );
    expect(provision.status).toBe(200);
    const { token } = (await provision.json()) as { token: string };
    expect(token).toBeTruthy();

    const page = await request(stub, `/app/setup?token=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("provisioned@example.test");
    expect(html).not.toContain('id="token"');

    const created = await request(stub, "/app/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        name: "Provisioned Owner",
        email: "provisioned@example.test",
        password: "correct horse battery staple",
        template: "personal",
      }),
    });
    expect(created.status).toBe(302);
    await expect(
      request(stub, `/app/setup?token=${encodeURIComponent(token)}`),
    ).resolves.toHaveProperty("status", 404);
  });
});

describe("Book auth in workerd", () => {
  it("sets up the owner, enrols TOTP, logs in and out", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName("tenant-runtime"));

    const setup = await request(stub, "/app/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "local-setup-token",
        name: "Runtime Owner",
        email: "owner@example.test",
        password: "correct horse battery staple",
        template: "insurance-agency",
      }),
    });
    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toBe("/app/security/totp");
    const cookie = cookieFrom(setup);

    const totpPage = await request(stub, "/app/security/totp", {
      headers: { cookie },
    });
    expect(totpPage.status).toBe(200);
    const html = await totpPage.text();
    const secret = /data-secret="([A-Z2-7]+)"/.exec(html)?.[1];
    expect(secret).toBeTruthy();
    if (!secret) throw new Error("missing TOTP secret in enrollment page");

    const code = await totpCode(secret, Date.now());
    const enrolled = await request(stub, "/app/security/totp", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }),
    });
    expect(enrolled.status).toBe(302);
    expect(enrolled.headers.get("location")).toBe("/app/books");

    const appRoot = await request(stub, "/app", { headers: { cookie } });
    expect(appRoot.status).toBe(302);
    expect(appRoot.headers.get("location")).toBe("/app/books");

    const books = await request(stub, "/app/books", { headers: { cookie } });
    expect(books.status).toBe(200);
    const booksHtml = await books.text();
    expect(booksHtml).toContain('href="/app/accounts"');
    expect(booksHtml).toContain('href="/app/settings"');
    expect(booksHtml).toContain("github.com/johnarleyburns/saldima");

    const settings = await request(stub, "/app/settings", { headers: { cookie } });
    expect(settings.status).toBe(200);
    const settingsHtml = await settings.text();
    expect(settingsHtml).toContain("owner@example.test");
    expect(settingsHtml).toContain("Book ");

    const accounts = await request(stub, "/app/accounts", { headers: { cookie } });
    expect(accounts.status).toBe(200);
    expect(await accounts.text()).toContain("Premium Trust");

    const created = await request(stub, "/app/accounts", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Petty Cash", type: "BANK", parent: "" }),
    });
    expect(created.status).toBe(302);
    const afterCreate = await request(stub, "/app/accounts", { headers: { cookie } });
    const createdHtml = await afterCreate.text();
    expect(createdHtml).toContain("Petty Cash");
    const pettyGuid =
      /data-account-guid="([0-9a-f]{32})" data-account-name="Petty Cash"/.exec(
        createdHtml,
      )?.[1];
    expect(pettyGuid).toBeTruthy();
    if (!pettyGuid) throw new Error("missing account GUID");

    const editPage = await request(stub, `/app/accounts/${pettyGuid}/edit`, {
      headers: { cookie },
    });
    expect(editPage.status).toBe(200);

    const updated = await request(stub, `/app/accounts/${pettyGuid}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Petty Cash Box",
        type: "BANK",
        parent: "",
        code: "1010",
        description: "Cash box",
        hidden: "on",
      }),
    });
    expect(updated.status).toBe(302);
    const updatedHtml = await (
      await request(stub, "/app/accounts", { headers: { cookie } })
    ).text();
    expect(updatedHtml).toContain("Petty Cash Box");
    expect(updatedHtml).toContain("hidden");

    const deleted = await request(stub, `/app/accounts/${pettyGuid}/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(deleted.status).toBe(302);
    const deletedHtml = await (
      await request(stub, "/app/accounts", { headers: { cookie } })
    ).text();
    expect(deletedHtml).not.toContain("Petty Cash Box");

    const closed = await request(stub, "/app/setup");
    expect(closed.status).toBe(404);

    const logout = await request(stub, "/app/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(302);

    const login = await request(stub, "/app/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "owner@example.test",
        password: "correct horse battery staple",
        template: "insurance-agency",
      }),
    });
    expect(login.status).toBe(302);
    const loginCookie = cookieFrom(login);

    const codeAgain = await totpCode(secret, Date.now());
    const verified = await request(stub, "/app/security/totp", {
      method: "POST",
      headers: {
        cookie: loginCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: codeAgain }),
    });
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/app/books");
  });

  it("posts a multi-split transaction (expense + input tax + payable)", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName("tenant-splits"));
    const setup = await request(stub, "/app/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "local-setup-token",
        name: "Splits Owner",
        email: "splits@example.test",
        password: "correct horse battery staple",
        template: "small-business",
      }),
    });
    const cookie = cookieFrom(setup);
    const totpPage = await request(stub, "/app/security/totp", { headers: { cookie } });
    const secret = /data-secret="([A-Z2-7]+)"/.exec(await totpPage.text())?.[1];
    if (!secret) throw new Error("missing TOTP secret");
    await request(stub, "/app/security/totp", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: await totpCode(secret, Date.now()) }),
    });

    const accountsHtml = await (
      await request(stub, "/app/accounts", { headers: { cookie } })
    ).text();
    const expenseGuid = accountGuidFrom(accountsHtml, "Supplies");
    const payableGuid = accountGuidFrom(accountsHtml, "Accounts Payable");
    const bankGuid = accountGuidFrom(accountsHtml, "Business Checking");
    expect(expenseGuid).not.toBe("");
    expect(payableGuid).not.toBe("");
    expect(bankGuid).not.toBe("");

    const posted = await request(stub, "/app/journal", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        date: "2026-01-15",
        description: "Supplier invoice with input tax",
        "split-account-0": expenseGuid,
        "split-amount-0": "100.00",
        "split-account-1": bankGuid,
        "split-amount-1": "19.00",
        "split-account-2": payableGuid,
        "split-amount-2": "-119.00",
      }),
    });
    expect(posted.status).toBe(302);
    expect(posted.headers.get("location")).toBe("/app/journal");

    const journalHtml = await (
      await request(stub, "/app/journal", { headers: { cookie } })
    ).text();
    expect(journalHtml).toContain("Supplier invoice with input tax");

    const unbalanced = await request(stub, "/app/journal", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        date: "2026-01-16",
        description: "Should not post",
        "split-account-0": expenseGuid,
        "split-amount-0": "10.00",
        "split-account-1": payableGuid,
        "split-amount-1": "-5.00",
      }),
    });
    expect(unbalanced.status).toBe(200);
    expect(await unbalanced.text()).toContain("must sum to zero");
    expect(
      await (await request(stub, "/app/journal", { headers: { cookie } })).text(),
    ).not.toContain("Should not post");
  });

  it("exports an account's register as QIF and CSV", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName("tenant-register-export"));
    const setup = await request(stub, "/app/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "local-setup-token",
        name: "Export Owner",
        email: "export@example.test",
        password: "correct horse battery staple",
        template: "small-business",
      }),
    });
    const cookie = cookieFrom(setup);
    const totpPage = await request(stub, "/app/security/totp", { headers: { cookie } });
    const secret = /data-secret="([A-Z2-7]+)"/.exec(await totpPage.text())?.[1];
    if (!secret) throw new Error("missing TOTP secret");
    await request(stub, "/app/security/totp", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: await totpCode(secret, Date.now()) }),
    });

    const accountsHtml = await (
      await request(stub, "/app/accounts", { headers: { cookie } })
    ).text();
    const expenseGuid = accountGuidFrom(accountsHtml, "Supplies");
    const bankGuid = accountGuidFrom(accountsHtml, "Business Checking");
    expect(expenseGuid).not.toBe("");
    expect(bankGuid).not.toBe("");

    await request(stub, "/app/journal", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        date: "2026-01-15",
        description: "Office supplies",
        "split-account-0": expenseGuid,
        "split-amount-0": "42.00",
        "split-account-1": bankGuid,
        "split-amount-1": "-42.00",
      }),
    });

    const qif = await request(stub, `/app/accounts/${bankGuid}/export/qif`, {
      headers: { cookie },
    });
    expect(qif.status).toBe(200);
    expect(qif.headers.get("content-type")).toBe("text/qif");
    expect(qif.headers.get("content-disposition")).toContain(
      'filename="Business-Checking.qif"',
    );
    const qifText = await qif.text();
    expect(qifText).toContain("!Type:Bank");
    expect(qifText).toContain("D2026-01-15");
    expect(qifText).toContain("T-42.00");
    expect(qifText).toContain("POffice supplies");
    expect(qifText).toContain("LSupplies");

    const csv = await request(stub, `/app/accounts/${bankGuid}/export/csv`, {
      headers: { cookie },
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv");
    expect(csv.headers.get("content-disposition")).toContain(
      'filename="Business-Checking.csv"',
    );
    const csvText = await csv.text();
    expect(csvText).toContain("Date,Description,Memo,Amount,Category,Reference");
    expect(csvText).toContain("2026-01-15,Office supplies,,-42.00,Supplies,");

    const unknown = await request(stub, `/app/accounts/${"f".repeat(32)}/export/qif`, {
      headers: { cookie },
    });
    expect(unknown.status).toBe(404);
  });
});

function accountGuidFrom(html: string, name: string): string {
  const pattern = new RegExp(
    `data-account-guid="([0-9a-f]{32})" data-account-name="${name}"`,
  );
  return pattern.exec(html)?.[1] ?? "";
}
