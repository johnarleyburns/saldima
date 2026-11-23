// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { InMemoryKeyValueStore } from "../../../packages/testkit/src/storage/memory-kv.ts";
import { InMemoryFaux } from "./provision.test-fakes.ts";
import { provisionTenant, TenantExistsError } from "./provision.ts";

function deps() {
  const kv = new InMemoryKeyValueStore();
  const email = new InMemoryFaux();
  return {
    kv,
    email,
    provisionBook: async (tenantId: string) => ({
      setupToken: `token-${tenantId}`,
    }),
    domain: "saldima.com",
    suffix: "-dev",
  };
}

describe("tenant provisioning", () => {
  it("maps the host, provisions the Book and emails a setup link", async () => {
    const d = deps();
    const result = await provisionTenant(d, {
      name: "acme",
      email: "owner@example.test",
      plan: "yearly",
    });
    expect(result.host).toBe("acme-dev.saldima.com");
    expect(result.tenantId).toMatch(/^tenant-[0-9a-f]{32}$/);
    expect(result.setupUrl).toBe(
      `https://acme-dev.saldima.com/app/setup?token=token-${result.tenantId}`,
    );
    expect(await d.kv.get("host:acme-dev.saldima.com")).toBe(result.tenantId);
    expect(d.email.messages).toHaveLength(1);
    expect(d.email.messages[0]?.to).toBe("owner@example.test");
    expect(d.email.messages[0]?.text).toContain(result.setupUrl);
  });

  it("refuses an already-claimed host", async () => {
    const d = deps();
    await d.kv.put("host:acme-dev.saldima.com", "tenant-existing");
    await expect(
      provisionTenant(d, {
        name: "acme",
        email: "owner@example.test",
        plan: "monthly",
      }),
    ).rejects.toBeInstanceOf(TenantExistsError);
  });
});
