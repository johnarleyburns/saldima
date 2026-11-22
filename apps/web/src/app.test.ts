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
    for (const host of ["saldima.com", "www.saldima.com", "stage.saldima.com"]) {
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

  it("keeps tenant content out of the marketing page", async () => {
    const app = createApp();
    const response = await app.request("http://alice.localhost/", {}, env());
    const html = await response.text();
    expect(html).toContain("tenant-alice");
    expect(html).toContain("Saldima");
  });
});
