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

describe("Book auth in workerd", () => {
  it("sets up the owner, enrols TOTP, logs in and out", async () => {
    const stub = env.BOOK.get(env.BOOK.idFromName("tenant-runtime"));

    const setup = await request(stub, "/app/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "test-setup-token",
        name: "Runtime Owner",
        email: "owner@example.test",
        password: "correct horse battery staple",
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
    expect(await dashboard.text()).toContain("owner@example.test");

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
