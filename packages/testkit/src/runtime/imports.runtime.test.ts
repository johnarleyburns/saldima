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

const TENANT = "tenant-imports";
const PASSWORD = "correct horse battery staple";

const QIF = `!Type:Bank
D01/15/2024
T100.00
PClient payment
LSales
N1001
^
`;

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("missing cookie");
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

function upload(
  stub: { fetch(request: Request): Promise<Response> },
  cookie: string,
  target: string,
  name: string,
  body: string,
): Promise<Response> {
  const data = new FormData();
  data.set("target", target);
  data.set("file", new File([body], name, { type: "text/plain" }));
  return request(stub, "/app/import/transactions", {
    method: "POST",
    headers: { cookie },
    body: data,
  });
}

function accountGuid(html: string, name: string): string {
  const match = new RegExp(
    `data-account-guid="([0-9a-f]{32})" data-account-name="${name}"`,
  ).exec(html);
  if (!match?.[1]) throw new Error(`missing account ${name}`);
  return match[1];
}

function importId(response: Response): string {
  const location = response.headers.get("location") ?? "";
  const match = /\/app\/import\/transactions\/([0-9a-f]{32})$/.exec(location);
  if (!match?.[1]) throw new Error(`missing import id in ${location}`);
  return match[1];
}

function count(html: string, text: string): number {
  return html.split(text).length - 1;
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
}): Promise<{
  cookie: string;
  accounts: string;
  checking: string;
  sales: string;
  rent: string;
}> {
  const setup = await form(stub, "/app/setup", "", {
    token: "local-setup-token",
    name: "Import Owner",
    email: "imports@example.test",
    password: PASSWORD,
    template: "small-business",
  });
  expect(setup.status).toBe(302);
  const cookie = cookieFrom(setup);
  const enrollment = await request(stub, "/app/security/totp", {
    headers: { cookie },
  });
  const secret = /data-secret="([A-Z2-7]+)"/.exec(await enrollment.text())?.[1];
  if (!secret) throw new Error("missing TOTP secret");
  await form(stub, "/app/security/totp", cookie, {
    code: await totpCode(secret, Date.now()),
  });
  const accounts = await request(stub, "/app/accounts", { headers: { cookie } });
  const html = await accounts.text();
  return {
    cookie,
    accounts: html,
    checking: accountGuid(html, "Business Checking"),
    sales: accountGuid(html, "Sales"),
    rent: accountGuid(html, "Rent"),
  };
}

describe("bank statement import", () => {
  it("maps, posts and skips duplicates without leaking across books", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName(TENANT));
    const { cookie, accounts, checking, sales, rent } = await setupTenant(stub);
    expect(accounts).toContain(">Business Checking<");

    // Upload QIF and land on the mapping screen.
    const firstUpload = await upload(stub, cookie, checking, "bank.qif", QIF);
    expect(firstUpload.status).toBe(302);
    const firstId = importId(firstUpload);
    const mapping = await request(stub, `/app/import/transactions/${firstId}`, {
      headers: { cookie },
    });
    expect(mapping.status).toBe(200);
    const mappingHtml = await mapping.text();
    expect(mappingHtml).toContain("Client payment");
    expect(mappingHtml).toContain("Sales");
    expect(mappingHtml).toContain("Imports");
    expect(mappingHtml).not.toContain("Possible duplicate");

    // Commit: one 100.00 deposit mapped to Sales.
    const committed = await form(stub, `/app/import/transactions/${firstId}`, cookie, {
      default_account: sales,
      category_0: sales,
    });
    expect(committed.status).toBe(302);
    expect(committed.headers.get("location")).toBe("/app/journal");

    const journal = await request(stub, "/app/journal", { headers: { cookie } });
    const journalHtml = await journal.text();
    expect(count(journalHtml, "Client payment")).toBe(1);
    const reports = await request(stub, "/app/reports", { headers: { cookie } });
    expect(await reports.text()).toContain("100.00");

    // The same file is flagged and skipped by default.
    const secondUpload = await upload(stub, cookie, checking, "bank.qif", QIF);
    const secondId = importId(secondUpload);
    const duplicateMap = await request(stub, `/app/import/transactions/${secondId}`, {
      headers: { cookie },
    });
    const duplicateHtml = await duplicateMap.text();
    expect(duplicateHtml).toContain("Possible duplicate");
    expect(duplicateHtml).toContain("1 possible duplicate");

    const skipped = await form(stub, `/app/import/transactions/${secondId}`, cookie, {
      default_account: sales,
      category_0: sales,
    });
    expect(skipped.status).toBe(200);
    expect(await skipped.text()).toContain("Every row looks like a duplicate");
    expect(
      count(
        await (await request(stub, "/app/journal", { headers: { cookie } })).text(),
        "Client payment",
      ),
    ).toBe(1);

    const included = await form(stub, `/app/import/transactions/${secondId}`, cookie, {
      default_account: sales,
      category_0: sales,
      include_duplicates: "on",
    });
    expect(included.status).toBe(302);
    expect(
      count(
        await (await request(stub, "/app/journal", { headers: { cookie } })).text(),
        "Client payment",
      ),
    ).toBe(2);

    // CSV goes through the same mapping and posts to an expense category.
    const csv = `Date,Description,Amount,Category
2024-02-01,Coffee,-4.50,Meals
`;
    const csvUpload = await upload(stub, cookie, checking, "bank.csv", csv);
    expect(csvUpload.status).toBe(302);
    const csvId = importId(csvUpload);
    const csvMap = await request(stub, `/app/import/transactions/${csvId}`, {
      headers: { cookie },
    });
    const csvMapHtml = await csvMap.text();
    expect(csvMapHtml).toContain("Meals");
    const csvCommitted = await form(stub, `/app/import/transactions/${csvId}`, cookie, {
      default_account: rent,
      category_0: rent,
    });
    expect(csvCommitted.status).toBe(302);
    const afterCsv = await (
      await request(stub, "/app/journal", { headers: { cookie } })
    ).text();
    expect(afterCsv).toContain("Coffee");
    expect(
      await (await request(stub, "/app/reports", { headers: { cookie } })).text(),
    ).toContain("95.50");

    // A second company imports independently.
    const created = await form(stub, "/app/books", cookie, {
      name: "Other Co",
      template: "small-business",
      currency: "USD",
    });
    expect(created.status).toBe(302);
    const otherCookie = `${cookie}; ${cookieFrom(created)}`;
    const otherAccounts = await request(stub, "/app/accounts", {
      headers: { cookie: otherCookie },
    });
    const otherHtml = await otherAccounts.text();
    const otherChecking = accountGuid(otherHtml, "Business Checking");
    const otherSales = accountGuid(otherHtml, "Sales");
    const otherUpload = await upload(
      stub,
      otherCookie,
      otherChecking,
      "other.qif",
      QIF.replace("Client payment", "Other only"),
    );
    const otherId = importId(otherUpload);
    const otherCommitted = await form(
      stub,
      `/app/import/transactions/${otherId}`,
      otherCookie,
      { default_account: otherSales, category_0: otherSales },
    );
    expect(otherCommitted.status).toBe(302);

    const firstJournal = await (
      await request(stub, "/app/journal", { headers: { cookie } })
    ).text();
    expect(firstJournal).not.toContain("Other only");
    expect(count(firstJournal, "Client payment")).toBe(2);
    const otherJournal = await (
      await request(stub, "/app/journal", { headers: { cookie: otherCookie } })
    ).text();
    expect(otherJournal).toContain("Other only");

    // A .gnucash import with a structural ROOT keeps it out of the tree but
    // still exports it.
    const rootBook = await form(stub, "/app/books", cookie, {
      name: "Root Co",
      template: "personal",
      currency: "USD",
    });
    expect(rootBook.status).toBe(302);
    const rootCookie = `${cookie}; ${cookieFrom(rootBook)}`;
    const rootGuid = "1".repeat(32);
    const rootXml = writeGnuCashXml({
      bookGuid: "c".repeat(32),
      currencyCode: "USD",
      fraction: 100,
      accounts: [
        {
          guid: rootGuid,
          name: "Root Account",
          type: "ROOT",
          parentGuid: null,
          commodityCode: null,
          code: "",
          description: "",
        },
        {
          guid: "2".repeat(32),
          name: "Bank",
          type: "BANK",
          parentGuid: rootGuid,
          commodityCode: "USD",
          code: "",
          description: "",
        },
      ],
      transactions: [],
    });
    const rootUpload = new FormData();
    rootUpload.set(
      "file",
      new File([await gzipText(rootXml)], "root.gnucash", {
        type: "application/gzip",
      }),
    );
    const importedRoot = await request(stub, "/app/import", {
      method: "POST",
      headers: { cookie: rootCookie },
      body: rootUpload,
    });
    expect(importedRoot.status).toBe(302);
    const rootAccounts = await (
      await request(stub, "/app/accounts", { headers: { cookie: rootCookie } })
    ).text();
    expect(rootAccounts).toContain(">Bank<");
    expect(rootAccounts).not.toContain("Root Account");
    const protectedRoot = await form(
      stub,
      `/app/accounts/${rootGuid}/delete`,
      rootCookie,
      {},
    );
    expect(protectedRoot.status).toBe(404);
    const rootExport = await request(stub, "/app/export/xml", {
      headers: { cookie: rootCookie },
    });
    const exportedXml = await gunzip(rootExport);
    expect(exportedXml).toContain("Root Account");
    expect(exportedXml).toContain(">Bank<");

    // Cancel drops the staged batch.
    const cancelUpload = await upload(stub, cookie, checking, "bank.qif", QIF);
    const cancelId = importId(cancelUpload);
    const cancelled = await form(
      stub,
      `/app/import/transactions/${cancelId}/cancel`,
      cookie,
      {},
    );
    expect(cancelled.status).toBe(302);
    const gone = await request(stub, `/app/import/transactions/${cancelId}`, {
      headers: { cookie },
    });
    expect(gone.status).toBe(404);
  });
});
