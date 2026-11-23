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
    expect(enrolled.headers.get("location")).toBe("/app");

    const dashboard = await request(stub, "/app", { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("owner@example.test");
    expect(dashboardHtml).toContain('href="/app/accounts"');
    expect(dashboardHtml).toContain('href="/app/settings"');
    expect(dashboardHtml).toContain("github.com/johnarleyburns/saldima");

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
    expect(verified.headers.get("location")).toBe("/app");
  });
});
