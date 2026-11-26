// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:test";
import { writeGnuCashXml } from "@saldima/gnucash";
import { describe, expect, it } from "vitest";
import { totpCode } from "../../../../apps/web/src/auth.ts";

interface BookNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    BOOK: BookNamespaceLike;
  }
}

const TENANT = "tenant-books";
const PASSWORD = "correct horse battery staple";

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

function form(
  stub: { fetch(request: Request): Promise<Response> },
  path: string,
  cookie: string,
  values: Record<string, string>,
): Promise<Response> {
  return request(stub, path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

function accountGuid(html: string, name: string): string {
  const match = new RegExp(
    `data-account-guid="([0-9a-f]{32})" data-account-name="${name}"`,
  ).exec(html);
  if (!match?.[1]) throw new Error(`missing account ${name}`);
  return match[1];
}

async function gzipText(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzip(response: Response): Promise<string> {
  const stream = response.body?.pipeThrough(new DecompressionStream("gzip"));
  if (!stream) throw new Error("missing export body");
  return new Response(stream).text();
}

async function setupTenant(stub: {
  fetch(request: Request): Promise<Response>;
}): Promise<{ cookie: string; secret: string }> {
  const setup = await form(stub, "/app/setup", "", {
    token: "local-setup-token",
    name: "Books Owner",
    email: "books@example.test",
    password: PASSWORD,
    template: "personal",
  });
  expect(setup.status).toBe(302);
  const cookie = cookieFrom(setup);

  const enrollment = await request(stub, "/app/security/totp", {
    headers: { cookie },
  });
  const html = await enrollment.text();
  const secret = /data-secret="([A-Z2-7]+)"/.exec(html)?.[1];
  if (!secret) throw new Error("missing TOTP secret");
  const enrolled = await form(stub, "/app/security/totp", cookie, {
    code: await totpCode(secret, Date.now()),
  });
  expect(enrolled.status).toBe(302);
  return { cookie, secret };
}

describe("multi-company books", () => {
  it("keeps two books in one workspace fully separate", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName(TENANT));
    const { cookie } = await setupTenant(stub);

    // The migration creates the default book and it is active.
    const firstList = await request(stub, "/app/books", { headers: { cookie } });
    expect(firstList.status).toBe(200);
    const firstListHtml = await firstList.text();
    expect(firstListHtml).toContain("My book");
    expect(firstListHtml).toContain("Personal");
    expect(firstListHtml).toContain("USD");
    const appRoot = await request(stub, "/app", { headers: { cookie } });
    expect(appRoot.status).toBe(302);
    expect(appRoot.headers.get("location")).toBe("/app/books");

    const accountsA = await request(stub, "/app/accounts", {
      headers: { cookie },
    });
    const accountsAHtml = await accountsA.text();
    expect(accountsAHtml).toContain(">Savings<");
    expect(accountsAHtml).not.toContain(">Business Checking<");
    const savingsGuid = accountGuid(accountsAHtml, "Savings");

    // Create a second company with its own seeded chart.
    const created = await form(stub, "/app/books", cookie, {
      name: "Acme Ltd",
      template: "small-business",
      currency: "EUR",
    });
    expect(created.status).toBe(302);
    const bookCookie = cookieFrom(created);
    const bookId = bookCookie.split("=")[1] ?? "";
    expect(bookId).toMatch(/^[0-9a-f]{32}$/);
    const activeCookie = `${cookie}; book=${bookId}`;

    const secondList = await request(stub, "/app/books", {
      headers: { cookie: activeCookie },
    });
    const secondListHtml = await secondList.text();
    expect(secondListHtml).toContain("Acme Ltd");
    expect(secondListHtml).toContain("Small business");
    expect(secondListHtml).toContain("EUR");
    expect(secondListHtml).toContain("Active");

    const accountsB = await request(stub, "/app/accounts", {
      headers: { cookie: activeCookie },
    });
    expect(accountsB.status).toBe(200);
    const accountsBHtml = await accountsB.text();
    expect(accountsBHtml).toContain(">Business Checking<");
    expect(accountsBHtml).toContain(">Sales<");
    expect(accountsBHtml).not.toContain(">Savings<");
    expect(accountsBHtml).toContain("Acme Ltd");

    // A guid from another company cannot be read, edited or deleted.
    const crossDelete = await form(
      stub,
      `/app/accounts/${savingsGuid}/delete`,
      activeCookie,
      {},
    );
    expect(crossDelete.status).toBe(404);
    const crossEdit = await form(stub, `/app/accounts/${savingsGuid}`, activeCookie, {
      name: "Stolen",
      type: "BANK",
      parent: "",
    });
    expect(crossEdit.status).toBe(404);
    expect(
      await (await request(stub, "/app/accounts", { headers: { cookie } })).text(),
    ).toContain(">Savings<");

    // Post a transaction in B only.
    const salesGuid = accountGuid(accountsBHtml, "Sales");
    const checkingGuid = accountGuid(accountsBHtml, "Business Checking");
    const posted = await form(stub, "/app/journal", activeCookie, {
      date: "2026-11-24",
      description: "Acme sale",
      from: checkingGuid,
      to: salesGuid,
      amount: "250.00",
    });
    expect(posted.status).toBe(302);

    const journalB = await request(stub, "/app/journal", {
      headers: { cookie: activeCookie },
    });
    expect(await journalB.text()).toContain("Acme sale");
    const reportsB = await request(stub, "/app/reports", {
      headers: { cookie: activeCookie },
    });
    const reportsBHtml = await reportsB.text();
    expect(reportsBHtml).toContain("250.00");

    // A sees none of B's postings, balances or reports.
    const journalA = await request(stub, "/app/journal", {
      headers: { cookie },
    });
    expect(await journalA.text()).not.toContain("Acme sale");
    const reportsA = await request(stub, "/app/reports", {
      headers: { cookie },
    });
    expect(await reportsA.text()).not.toContain("250.00");

    // An unknown cookie falls back to the first book, never to another tenant.
    const fallback = await request(stub, "/app/accounts", {
      headers: { cookie: `${cookie}; book=not-a-book` },
    });
    expect(fallback.status).toBe(200);
    const fallbackHtml = await fallback.text();
    expect(fallbackHtml).toContain(">Savings<");
    expect(fallbackHtml).not.toContain(">Business Checking<");

    // Selecting a book sets the cookie and changes every view.
    const selected = await form(stub, "/app/books/main/select", cookie, {});
    expect(selected.status).toBe(302);
    expect(cookieFrom(selected)).toBe("book=main");
    const selectedAccounts = await request(stub, "/app/accounts", {
      headers: { cookie: `${cookie}; book=main` },
    });
    const selectedHtml = await selectedAccounts.text();
    expect(selectedHtml).toContain(">Savings<");
    expect(selectedHtml).not.toContain(">Business Checking<");

    // Export writes only the active book, named after the company.
    const exportA = await request(stub, "/app/export/xml", {
      headers: { cookie },
    });
    expect(exportA.status).toBe(200);
    expect(exportA.headers.get("content-disposition")).toContain(
      'filename="My-book.gnucash"',
    );
    const exportAXml = await gunzip(exportA);
    expect(exportAXml).toContain("Savings");
    expect(exportAXml).not.toContain("Acme sale");

    const exportB = await request(stub, "/app/export/xml", {
      headers: { cookie: activeCookie },
    });
    expect(exportB.headers.get("content-disposition")).toContain(
      'filename="Acme-Ltd.gnucash"',
    );
    const exportBXml = await gunzip(exportB);
    expect(exportBXml).toContain("Acme sale");
    expect(exportBXml).not.toContain("Savings");
    expect(exportBXml).toContain("<cmdty:id>EUR</cmdty:id>");

    // Importing into B replaces B only.
    const importedGuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const xml = writeGnuCashXml({
      bookGuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      currencyCode: "USD",
      fraction: 100,
      accounts: [
        {
          guid: importedGuid,
          name: "Imported Cash",
          type: "BANK",
          parentGuid: null,
          commodityCode: "USD",
          code: "",
          description: "",
        },
      ],
      transactions: [],
    });
    const upload = new FormData();
    upload.set(
      "file",
      new File([await gzipText(xml)], "import.gnucash", {
        type: "application/gzip",
      }),
    );
    const imported = await request(stub, "/app/import", {
      method: "POST",
      headers: { cookie: activeCookie },
      body: upload,
    });
    expect(imported.status).toBe(302);

    const afterImportB = await request(stub, "/app/accounts", {
      headers: { cookie: activeCookie },
    });
    const afterImportBHtml = await afterImportB.text();
    expect(afterImportBHtml).toContain(">Imported Cash<");
    expect(afterImportBHtml).not.toContain(">Business Checking<");
    const afterImportA = await request(stub, "/app/accounts", {
      headers: { cookie },
    });
    const afterImportAHtml = await afterImportA.text();
    expect(afterImportAHtml).toContain(">Savings<");
    expect(afterImportAHtml).not.toContain(">Imported Cash<");

    // Rename is scoped to the active company.
    const renamed = await form(stub, `/app/books/${bookId}/rename`, activeCookie, {
      name: "Acme Holdings",
    });
    expect(renamed.status).toBe(302);
    const settings = await request(stub, "/app/settings", {
      headers: { cookie: activeCookie },
    });
    expect(await settings.text()).toContain("Acme Holdings");
    const stillA = await request(stub, "/app/settings", {
      headers: { cookie },
    });
    expect(await stillA.text()).toContain("My book");

    // Deleting the active company falls back to the remaining book.
    const deleted = await form(stub, `/app/books/${bookId}/delete`, activeCookie, {});
    expect(deleted.status).toBe(302);
    expect(cookieFrom(deleted)).toBe("book=");
    const listAfterDelete = await request(stub, "/app/books", {
      headers: { cookie },
    });
    expect(await listAfterDelete.text()).not.toContain("Acme Holdings");
    const afterDeleteA = await request(stub, "/app/accounts", {
      headers: { cookie },
    });
    expect(await afterDeleteA.text()).toContain(">Savings<");

    // The last book cannot be deleted.
    const lastDelete = await form(stub, "/app/books/main/delete", cookie, {});
    expect(lastDelete.status).toBe(409);
    expect(
      await (await request(stub, "/app/accounts", { headers: { cookie } })).text(),
    ).toContain(">Savings<");
  });
});
