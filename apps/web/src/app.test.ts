// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { InMemoryKeyValueStore } from "../../../packages/testkit/src/storage/memory-kv.ts";
import { createApp } from "./app.ts";

function env(kv = new InMemoryKeyValueStore()) {
  return { KV: kv, R2: {} as never, BOOK: {} as never };
}

describe("tenant resolution before routing", () => {
  it("gives alice and bob separate tenants", async () => {
    const app = createApp();
    const kv = new InMemoryKeyValueStore();
    const alice = await app.request("http://alice.localhost/health", {}, env(kv));
    const bob = await app.request("http://bob.localhost/health", {}, env(kv));
    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    const aliceBody = (await alice.json()) as { tenant: string };
    const bobBody = (await bob.json()) as { tenant: string };
    expect(aliceBody.tenant).toBe("tenant-alice");
    expect(bobBody.tenant).toBe("tenant-bob");
    expect(aliceBody.tenant).not.toBe(bobBody.tenant);
  });

  it("remembers the hostname mapping after the first request", async () => {
    const app = createApp();
    const kv = new InMemoryKeyValueStore();
    await app.request("http://alice.localhost/health", {}, env(kv));
    expect(kv.values.get("host:alice.localhost")).toBe("tenant-alice");
    await app.request("http://alice.localhost/app", {}, env(kv));
    expect(kv.values.size).toBe(1);
  });

  it("serves the apex as marketing, not as a tenant", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/", {}, env());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Saldima");
    const health = await app.request("http://localhost/health", {}, env());
    expect(await health.json()).toEqual({
      ok: true,
      tenant: null,
      host: "localhost",
    });
  });

  it("serves the production and staging apexes as marketing", async () => {
    const app = createApp();
    for (const host of [
      "saldima.com",
      "www.saldima.com",
      "stage.saldima.com",
      "dev.saldima.com",
    ]) {
      const response = await app.request(`http://${host}/health`, {}, env());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, tenant: null, host });
    }
  });

  it("routes a custom hostname through KV", async () => {
    const app = createApp();
    const kv = new InMemoryKeyValueStore();
    await kv.put("host:books.acme.test", "tenant-acme");
    const response = await app.request("http://books.acme.test/health", {}, env(kv));
    expect(await response.json()).toMatchObject({ tenant: "tenant-acme" });
  });

  it("404s an unknown hostname before any tenant route runs", async () => {
    const app = createApp();
    const response = await app.request("http://nobody.test/health", {}, env());
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("No book");
  });

  it("404s unsafe local subdomains", async () => {
    const app = createApp();
    const response = await app.request("http://bad_host.localhost/health", {}, env());
    expect(response.status).toBe(404);
  });

  it("forwards /app requests to the tenant Book object", async () => {
    const app = createApp();
    let tenant = "";
    const response = await app.request(
      "http://alice.localhost/app/login",
      {},
      {
        KV: new InMemoryKeyValueStore(),
        R2: {} as never,
        BOOK: {
          idFromName(name: string) {
            tenant = name;
            return name;
          },
          get() {
            return {
              async fetch(request: Request) {
                return new Response(new URL(request.url).pathname);
              },
            };
          },
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/app/login");
    expect(tenant).toBe("tenant-alice");
  });

  it("sends a tenant root straight to its book, never the marketing page", async () => {
    const app = createApp();
    const response = await app.request("http://alice.localhost/", {}, env());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app");
  });
});

describe("Stripe signup", () => {
  function signing(payload: string, secret: string, timestamp: number) {
    return (async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${timestamp}.${payload}`),
        ),
      );
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      return `t=${timestamp},v1=${hex}`;
    })();
  }

  const stripeEnv = (kv: InMemoryKeyValueStore, fetchImpl: typeof fetch) => ({
    KV: kv,
    R2: {} as never,
    BOOK: {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/internal/provision") {
            return Response.json({ token: "setup-token" });
          }
          return new Response("book");
        },
      }),
    },
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_PRICE_MONTHLY: "price_month",
    STRIPE_PRICE_YEARLY: "price_year",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    PROVISION_SECRET: "provision-secret",
    TENANT_DOMAIN: "saldima.com",
    TENANT_SUFFIX: "-dev",
    APP_ORIGIN: "https://dev.saldima.com",
    FETCH: fetchImpl,
  });

  it("starts a Checkout Session and redirects to Stripe", async () => {
    const kv = new InMemoryKeyValueStore();
    let body = "";
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ id: "cs_1", url: "https://checkout.stripe.test/1" });
    }) as typeof fetch;
    const response = await createApp().request(
      "http://dev.saldima.com/api/signup/checkout",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "acme",
          email: "owner@example.test",
          plan: "yearly",
        }),
      },
      stripeEnv(kv, fakeFetch),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/1");
    expect(body).toContain("price_year");
    expect(body).toContain("dev.saldima.com%2Fbilling%2Fsuccess");
  });

  it("provisions a tenant from a signed webhook and exposes the setup link", async () => {
    const kv = new InMemoryKeyValueStore();
    const env = stripeEnv(kv, fetch);
    const event = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          customer_email: "owner@example.test",
          metadata: { tenantName: "acme", plan: "yearly", email: "owner@example.test" },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signing(event, "whsec_test", timestamp);
    const response = await createApp().request(
      "http://dev.saldima.com/stripe/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: event,
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await kv.get("host:acme-dev.saldima.com")).toMatch(/^tenant-/);
    expect(await kv.get("checkout:cs_1")).toContain(
      "https://acme-dev.saldima.com/app/setup?token=setup-token",
    );

    const success = await createApp().request(
      "http://dev.saldima.com/billing/success?session_id=cs_1",
      {},
      env,
    );
    expect(await success.text()).toContain(
      "https://acme-dev.saldima.com/app/setup?token=setup-token",
    );
  });
});
